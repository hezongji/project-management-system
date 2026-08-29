/**
 * /api/admin/permissions/[userId] —— 权限分配（权限 V2 2026-08-21）
 *
 * GET   ADMIN  查看用户当前权限配置（页面权限 + 额外可见项目）
 * PUT   ADMIN  保存用户权限配置
 *
 * 管理员在「系统管理 → 权限分配」为每个用户统一分配：
 *   - 页面权限 pagePermissions：可见页面 key 数组（null=按角色默认）
 *   - 额外可见项目 extraVisibleProjectIds：超出项目成员制的授权可见项目
 *   - 财务等数据权限由「角色 + 项目角色」自动派生（data-visibility.ts），不在此配置
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { invalidatePerms } from '@/lib/permission'
import { resolveUserPages, isValidPageKeys } from '@/lib/page-permissions'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ userId: string }> }

// ───────────────────────────── GET：查看 ─────────────────────────────

export const GET = apiHandler(async (_request: NextRequest, { params }: Ctx) => {
  const { userId } = await params
  await requireAdmin(_request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      isActive: true,
      departmentId: true,
      department: { select: { name: true } },
      pagePermissions: true,
      extraVisibleProjectIds: true,
    },
  })
  if (!user) throw ApiError.notFound('用户不存在')

  const pageKeys = user.pagePermissions as string[] | null
  return ok({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      departmentName: user.department?.name ?? null,
    },
    config: {
      pagePermissions: pageKeys, // null=按角色默认
      resolvedPages: resolveUserPages(user.role, pageKeys),
      extraVisibleProjectIds: user.extraVisibleProjectIds,
    },
  })
})

// ───────────────────────────── PUT：保存 ─────────────────────────────

const putSchema = z.object({
  pagePermissions: z.array(z.string()).nullable().optional(),
  extraVisibleProjectIds: z.array(z.string()).optional(),
})

export const PUT = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { userId } = await params
  const admin = await requireAdmin(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = putSchema.parse(raw)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  })
  if (!user) throw ApiError.notFound('用户不存在')
  // ADMIN 权限不可被降级（其页面恒全量），但可配置额外可见项目
  const isAdmin = user.role === 'ADMIN'

  const data: Record<string, unknown> = {}

  if (body.pagePermissions !== undefined) {
    if (isAdmin) {
      // ADMIN 恒全量页面，忽略页面权限配置（避免误锁）
      // 但允许显式传 null 表示"按角色默认"（对 ADMIN 无实际影响）
      if (body.pagePermissions !== null) {
        throw ApiError.badRequest('管理员（ADMIN）页面权限不可配置，恒为全部页面')
      }
    } else if (body.pagePermissions === null) {
      data.pagePermissions = null // 重置为按角色默认
    } else {
      if (!isValidPageKeys(body.pagePermissions)) {
        throw ApiError.badRequest('页面权限包含非法页面标识')
      }
      data.pagePermissions = body.pagePermissions
    }
  }

  if (body.extraVisibleProjectIds !== undefined) {
    // 校验项目存在（去重）
    const ids = Array.from(new Set(body.extraVisibleProjectIds))
    const projects = await prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })
    if (projects.length !== ids.length) {
      throw ApiError.badRequest('存在无效的项目 id')
    }
    data.extraVisibleProjectIds = ids
  }

  if (Object.keys(data).length === 0) {
    return ok({ message: '无变更' })
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data }),
    prisma.activityLog.create({
      data: {
        userId: admin.userId,
        action: 'user.permissions.update',
        detail: { userId: userId, ...data } as Prisma.InputJsonValue,
      },
    }),
  ])

  // 权限缓存失效（列表/详情判定重算）
  invalidatePerms(userId)

  return ok({ message: '权限已更新' })
})
