/**
 * /api/external-orgs/[id] —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * PATCH   ADMIN  维护外部主体 { name?, type?, phone?, address?, remark?, isActive? }
 * DELETE  ADMIN  删除外部主体（联系人级联删除；被项目 customerId 引用时 400 拒绝）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ExternalOrgType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  name: z.string().trim().min(1, '主体名称不能为空').max(120).optional(),
  type: z.nativeEnum(ExternalOrgType).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  remark: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = patchSchema.parse(await request.json())
  const org = await prisma.externalOrg.findUnique({ where: { id: id } })
  if (!org) throw ApiError.notFound('外部主体不存在')

  const nextName = body.name ?? org.name
  const nextType = body.type ?? org.type
  if (nextName !== org.name || nextType !== org.type) {
    const dup = await prisma.externalOrg.findFirst({
      where: { name: nextName, type: nextType, id: { not: org.id } },
    })
    if (dup) throw new ApiError(409, `同类型下已存在主体「${nextName}」`, 'CONFLICT')
  }

  const updated = await prisma.externalOrg.update({
    where: { id: org.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
      ...(body.address !== undefined ? { address: body.address || null } : {}),
      ...(body.remark !== undefined ? { remark: body.remark || null } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    },
    include: { contacts: true },
  })
  return ok(updated, '外部主体已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const org = await prisma.externalOrg.findUnique({
    where: { id: id },
    include: { _count: { select: { contacts: true } } },
  })
  if (!org) throw ApiError.notFound('外部主体不存在')

  const projectRefs = await prisma.project.count({ where: { customerId: org.id } })
  if (projectRefs > 0) {
    throw ApiError.badRequest(
      `主体「${org.name}」正被 ${projectRefs} 个项目引用为客户，不能删除（可将主体停用代替）`
    )
  }

  await prisma.externalOrg.delete({ where: { id: org.id } })
  return ok({ id: org.id }, `外部主体「${org.name}」及其 ${org._count.contacts} 名联系人已删除`)
})
