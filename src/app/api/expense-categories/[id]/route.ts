/**
 * /api/expense-categories/[id] —— 费用分类修改/删除（F2，仅 ADMIN）
 *
 * PATCH  编辑（name/code/sort/isActive；系统预置分类仅允许改 sort/isActive）
 * DELETE 删除（自定义分类；已被费用明细引用 → 400 拒绝；系统预置不可删）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchCategorySchema = z.object({
  name: z.string().trim().min(1, '分类名称不能为空').max(50, '分类名称过长').optional(),
  code: z
    .string()
    .trim()
    .min(1, '分类编码不能为空')
    .max(30, '分类编码过长')
    .regex(/^[A-Za-z0-9_-]+$/, '分类编码仅允许字母/数字/下划线/中划线')
    .optional(),
  sort: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchCategorySchema.parse(raw)

  const existing = await prisma.expenseCategory.findUnique({ where: { id: id } })
  if (!existing) throw ApiError.notFound('费用分类不存在')

  // 系统预置分类：名称/编码不可改（可改排序与启用状态）
  if (existing.isSystem && (body.name !== undefined || body.code !== undefined)) {
    throw ApiError.badRequest('系统预置分类不可修改名称或编码')
  }
  if (
    Object.keys(body).length === 0 ||
    (body.name === undefined && body.code === undefined && body.sort === undefined && body.isActive === undefined)
  ) {
    throw ApiError.badRequest('没有可更新的字段')
  }

  // 唯一性预检查（排除自身）
  if (body.name !== undefined && body.name !== existing.name) {
    const dup = await prisma.expenseCategory.findFirst({
      where: { name: body.name, id: { not: existing.id } },
      select: { id: true },
    })
    if (dup) throw ApiError.badRequest(`分类名称「${body.name}」已存在`)
  }
  if (body.code !== undefined && body.code !== existing.code) {
    const dup = await prisma.expenseCategory.findFirst({
      where: { code: body.code, id: { not: existing.id } },
      select: { id: true },
    })
    if (dup) throw ApiError.badRequest(`分类编码「${body.code}」已存在`)
  }

  const item = await prisma.expenseCategory.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.code !== undefined && { code: body.code }),
      ...(body.sort !== undefined && { sort: body.sort }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  return ok(item, '费用分类已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const existing = await prisma.expenseCategory.findUnique({ where: { id: id } })
  if (!existing) throw ApiError.notFound('费用分类不存在')

  if (existing.isSystem) throw ApiError.badRequest('系统预置分类不可删除')

  // 有关联费用明细 → 拒绝删除（数据完整性）
  const refCount = await prisma.expenseItem.count({
    where: { categoryId: existing.id },
  })
  if (refCount > 0) {
    throw ApiError.badRequest(`该分类已被 ${refCount} 条费用明细使用，无法删除`)
  }

  await prisma.expenseCategory.delete({ where: { id: existing.id } })
  return ok({ id: existing.id }, '费用分类已删除')
})
