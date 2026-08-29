/**
 * /api/expense-categories —— 费用分类字典（F2：分类管理）
 *
 * GET  分类列表（仅 isActive=true，按 sort 升序；登录即可见，创建费用时下拉用）
 * POST 新建自定义分类（仅 ADMIN，isSystem=false）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createCategorySchema = z.object({
  name: z.string().trim().min(1, '分类名称不能为空').max(50, '分类名称过长'),
  code: z
    .string()
    .trim()
    .min(1, '分类编码不能为空')
    .max(30, '分类编码过长')
    .regex(/^[A-Za-z0-9_-]+$/, '分类编码仅允许字母/数字/下划线/中划线')
    .optional(),
  sort: z.number().int().optional(),
})

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)

  const items = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
  })

  return ok(items)
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createCategorySchema.parse(raw)

  // 编码缺省自动生成：CUSTOM-001 递增
  let code = body.code
  if (!code) {
    const last = await prisma.expenseCategory.findFirst({
      where: { code: { startsWith: 'CUSTOM-' } },
      orderBy: { code: 'desc' },
      select: { code: true },
    })
    const seq = last ? parseInt(last.code.slice('CUSTOM-'.length), 10) + 1 : 1
    code = `CUSTOM-${String(seq).padStart(3, '0')}`
  }

  // 唯一性预检查（name/code 均 unique，避免 500）
  const dupName = await prisma.expenseCategory.findFirst({
    where: { name: body.name },
    select: { id: true },
  })
  if (dupName) throw ApiError.badRequest(`分类名称「${body.name}」已存在`)
  const dupCode = await prisma.expenseCategory.findFirst({
    where: { code },
    select: { id: true },
  })
  if (dupCode) throw ApiError.badRequest(`分类编码「${code}」已存在`)

  const item = await prisma.expenseCategory.create({
    data: {
      name: body.name,
      code,
      sort: body.sort ?? 0,
      isSystem: false,
      isActive: true,
    },
  })

  return created(item, '费用分类已创建')
})
