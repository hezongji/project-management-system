/**
 * /api/departments/[id] —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * PATCH   ADMIN  维护部门 { name?, parentId?, managerId?, sort? }（含循环引用检测）
 * DELETE  ADMIN  删除部门（需空部门：无子部门且无成员，否则 400 §7.2）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  name: z.string().trim().min(1, '部门名称不能为空').max(50).optional(),
  parentId: z.string().trim().nullable().optional(),
  managerId: z.string().trim().nullable().optional(),
  sort: z.number().int().min(0).max(999).optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = patchSchema.parse(await request.json())
  const dept = await prisma.department.findUnique({ where: { id: id } })
  if (!dept) throw ApiError.notFound('部门不存在')

  if (body.parentId !== undefined) {
    if (body.parentId) {
      if (body.parentId === dept.id) {
        throw ApiError.badRequest('上级部门不能是部门自身')
      }
      const parent = await prisma.department.findUnique({ where: { id: body.parentId } })
      if (!parent) throw ApiError.badRequest('上级部门不存在')
      // 循环引用检测：沿新父级链向上爬，碰到自己即循环
      let cursor = await prisma.department.findUnique({ where: { id: body.parentId } })
      while (cursor) {
        if (cursor.id === dept.id) {
          throw ApiError.badRequest('不能将部门移动到自己的子部门下（循环引用）')
        }
        cursor = cursor.parentId
          ? await prisma.department.findUnique({ where: { id: cursor.parentId } })
          : null
      }
    }
    if (body.parentId !== dept.parentId && body.name === undefined) {
      // 换父级时校验目标父级下同名
      const dup = await prisma.department.findFirst({
        where: { name: dept.name, parentId: body.parentId || null, id: { not: dept.id } },
      })
      if (dup) throw new ApiError(409, `目标层级已存在同名部门「${dept.name}」`, 'CONFLICT')
    }
  }

  if (body.name !== undefined && body.name !== dept.name) {
    const dup = await prisma.department.findFirst({
      where: { name: body.name, parentId: body.parentId ?? dept.parentId, id: { not: dept.id } },
    })
    if (dup) throw new ApiError(409, `同级已存在同名部门「${body.name}」`, 'CONFLICT')
  }

  if (body.managerId) {
    const manager = await prisma.user.findUnique({ where: { id: body.managerId } })
    if (!manager) throw ApiError.badRequest('部门负责人不存在')
  }

  const updated = await prisma.department.update({
    where: { id: dept.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId || null } : {}),
      ...(body.managerId !== undefined ? { managerId: body.managerId || null } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
    },
  })
  return ok(updated, '部门已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const dept = await prisma.department.findUnique({
    where: { id: id },
    include: { _count: { select: { children: true, members: true } } },
  })
  if (!dept) throw ApiError.notFound('部门不存在')

  if (dept._count.children > 0) {
    throw ApiError.badRequest(`部门「${dept.name}」下还有 ${dept._count.children} 个子部门，请先删除或转移子部门`)
  }
  const memberCount = await prisma.user.count({ where: { departmentId: dept.id, isActive: true } })
  if (memberCount > 0) {
    throw ApiError.badRequest(`部门「${dept.name}」下还有 ${memberCount} 名成员，请先转移成员到其他部门`)
  }

  await prisma.department.delete({ where: { id: dept.id } })
  return ok({ id: dept.id }, `部门「${dept.name}」已删除`)
})
