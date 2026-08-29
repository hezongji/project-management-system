/**
 * /api/job-titles —— 依据《开发文档-项目管理系统重构》§7.2、§10.1
 *
 * GET   登录   岗位字典（按 sort 升序，附在职人数 userCount）
 * POST  ADMIN  新建岗位 { name, deptHint?, sort? }
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)

  const titles = await prisma.jobTitle.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] })
  // 在职人数（User.jobTitle 冗余字符串计数）+ 流程模板阶段引用计数
  const [userCounts, stageCounts] = await Promise.all([
    prisma.user.groupBy({ by: ['jobTitle'], where: { isActive: true }, _count: { _all: true } }),
    prisma.templateStage.groupBy({ by: ['ownerJobTitle'], _count: { _all: true } }),
  ])
  const userCountByTitle = new Map(userCounts.map((g) => [g.jobTitle, g._count._all]))
  const stageCountByTitle = new Map(stageCounts.map((g) => [g.ownerJobTitle, g._count._all]))

  return ok({
    items: titles.map((t) => ({
      ...t,
      userCount: userCountByTitle.get(t.name) ?? 0,
      stageCount: stageCountByTitle.get(t.name) ?? 0,
    })),
  })
})

const createSchema = z.object({
  name: z.string().trim().min(1, '岗位名称不能为空').max(50),
  deptHint: z.string().trim().max(100).nullable().optional(),
  sort: z.number().int().min(0).max(999).optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = createSchema.parse(await request.json())
  const dup = await prisma.jobTitle.findUnique({ where: { name: body.name } })
  if (dup) throw new ApiError(409, `岗位「${body.name}」已存在`, 'CONFLICT')

  const title = await prisma.jobTitle.create({
    data: {
      name: body.name,
      deptHint: body.deptHint || null,
      sort: body.sort ?? 0,
    },
  })
  return created(title, '岗位已创建')
})
