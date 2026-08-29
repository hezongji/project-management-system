/**
 * /api/departments —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * GET    登录    部门树（含成员数、负责人、在职成员摘要）
 * POST   ADMIN  新建部门 { name, parentId?, managerId?, sort? }
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { loadDeptTree } from '@/lib/org-service'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)
  const tree = await loadDeptTree()
  return ok({ items: tree })
})

const createSchema = z.object({
  name: z.string().trim().min(1, '部门名称不能为空').max(50),
  parentId: z.string().trim().nullable().optional(),
  managerId: z.string().trim().nullable().optional(),
  sort: z.number().int().min(0).max(999).optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = createSchema.parse(await request.json())
  const name = body.name

  if (body.parentId) {
    const parent = await prisma.department.findUnique({ where: { id: body.parentId } })
    if (!parent) throw ApiError.badRequest('上级部门不存在')
  }
  if (body.managerId) {
    const manager = await prisma.user.findUnique({ where: { id: body.managerId } })
    if (!manager) throw ApiError.badRequest('部门负责人不存在')
  }

  // 同一父级下名称唯一
  const dup = await prisma.department.findFirst({
    where: { name, parentId: body.parentId ?? null },
  })
  if (dup) {
    throw new ApiError(409, `同级已存在同名部门「${name}」`, 'CONFLICT')
  }

  const dept = await prisma.department.create({
    data: {
      name,
      parentId: body.parentId || null,
      managerId: body.managerId || null,
      sort: body.sort ?? 0,
    },
  })
  return created(dept, '部门已创建')
})
