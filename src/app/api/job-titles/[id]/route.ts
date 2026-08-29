/**
 * /api/job-titles/[id] —— 依据《开发文档-项目管理系统重构》§7.2、§5 JobTitle
 *
 * PATCH   ADMIN  维护岗位 { name?, deptHint?, sort? }；改名时同步刷新
 *         User.jobTitle 与 TemplateStage.ownerJobTitle（冗余字符串保持一致）
 * DELETE  ADMIN  删除岗位；被在职人员或流程模板阶段引用时 400 拒绝
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  name: z.string().trim().min(1, '岗位名称不能为空').max(50).optional(),
  deptHint: z.string().trim().max(100).nullable().optional(),
  sort: z.number().int().min(0).max(999).optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = patchSchema.parse(await request.json())
  const title = await prisma.jobTitle.findUnique({ where: { id: id } })
  if (!title) throw ApiError.notFound('岗位不存在')

  if (body.name !== undefined && body.name !== title.name) {
    const dup = await prisma.jobTitle.findUnique({ where: { name: body.name } })
    if (dup) throw new ApiError(409, `岗位「${body.name}」已存在`, 'CONFLICT')
  }

  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.jobTitle.update({
      where: { id: title.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.deptHint !== undefined ? { deptHint: body.deptHint || null } : {}),
        ...(body.sort !== undefined ? { sort: body.sort } : {}),
      },
    })
    // 改名 → 同步冗余引用（§5：User.jobTitle / TemplateStage.ownerJobTitle）
    if (body.name !== undefined && body.name !== title.name) {
      await tx.user.updateMany({ where: { jobTitle: title.name }, data: { jobTitle: body.name } })
      await tx.templateStage.updateMany({
        where: { ownerJobTitle: title.name },
        data: { ownerJobTitle: body.name },
      })
    }
    return t
  })
  return ok(updated, '岗位已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const title = await prisma.jobTitle.findUnique({ where: { id: id } })
  if (!title) throw ApiError.notFound('岗位不存在')

  const [userRefs, stageRefs] = await Promise.all([
    prisma.user.count({ where: { jobTitle: title.name, isActive: true } }),
    prisma.templateStage.count({ where: { ownerJobTitle: title.name } }),
  ])
  if (userRefs > 0 || stageRefs > 0) {
    const parts: string[] = []
    if (userRefs > 0) parts.push(`${userRefs} 名在职人员`)
    if (stageRefs > 0) parts.push(`${stageRefs} 个流程模板阶段`)
    throw ApiError.badRequest(
      `岗位「${title.name}」正被${parts.join('、')}引用，请先解除引用（调整人员岗位 / 修改流程模板）再删除`
    )
  }

  await prisma.jobTitle.delete({ where: { id: title.id } })
  return ok({ id: title.id }, `岗位「${title.name}」已删除`)
})
