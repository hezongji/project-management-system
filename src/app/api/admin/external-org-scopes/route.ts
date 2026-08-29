/**
 * /api/admin/external-org-scopes —— 外部主体类型可见性配置（权限 V2.1 2026-08-21）
 *
 * GET  ADMIN  查看 5 种类型的可见性配置（含部门/用户选项）
 * PUT  ADMIN  保存配置（按类型设置 PUBLIC 或 RESTRICTED + deptIds/userIds）
 *
 * 前端在「系统管理 → 权限分配 → 外部主体可见性」配置。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ExternalOrgType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { invalidatePerms } from '@/lib/permission'

export const dynamic = 'force-dynamic'

const ALL_TYPES = Object.values(ExternalOrgType)

// ───────────────────────────── GET：查看 ─────────────────────────────

export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAdmin(_request)

  const [scopes, departments, users] = await Promise.all([
    prisma.externalOrgScope.findMany(),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, username: true, departmentId: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const byType = new Map(scopes.map((s) => [s.type, s]))

  return ok({
    types: ALL_TYPES.map((t) => {
      const s = byType.get(t)
      return {
        type: t,
        visibility: s?.visibility ?? 'RESTRICTED',
        deptIds: s?.deptIds ?? [],
        userIds: s?.userIds ?? [],
        configured: !!s,
      }
    }),
    departments,
    users,
  })
})

// ───────────────────────────── PUT：保存 ─────────────────────────────

const putSchema = z.object({
  scopes: z
    .array(
      z.object({
        type: z.enum(ALL_TYPES as [ExternalOrgType, ...ExternalOrgType[]]),
        visibility: z.enum(['PUBLIC', 'RESTRICTED']),
        deptIds: z.array(z.string()).optional(),
        userIds: z.array(z.string()).optional(),
      }),
    )
    .min(1),
})

export const PUT = apiHandler(async (request: NextRequest) => {
  const admin = await requireAdmin(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = putSchema.parse(raw)

  await prisma.$transaction(
    body.scopes.map((s) =>
      prisma.externalOrgScope.upsert({
        where: { type: s.type },
        create: {
          type: s.type,
          visibility: s.visibility,
          deptIds: Array.from(new Set(s.deptIds ?? [])),
          userIds: Array.from(new Set(s.userIds ?? [])),
          updatedById: admin.userId,
        },
        update: {
          visibility: s.visibility,
          deptIds: Array.from(new Set(s.deptIds ?? [])),
          userIds: Array.from(new Set(s.userIds ?? [])),
          updatedById: admin.userId,
        },
      }),
    ),
  )

  // 全量失效（外部主体可见性影响所有用户）
  invalidatePerms()

  return ok({ message: '外部主体可见性已更新' })
})
