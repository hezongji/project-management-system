/**
 * /api/projects/[id]/expense-claims —— 项目报销单列表/新建（F2-R2 报销单+明细重构）
 *
 * GET  报销单列表（★ 可见性：仅 报销人本人(payeeId/createdById==me) + 财务部 + ADMIN；
 *      项目 OWNER/MANAGER/其他成员一律不可见 → 列表为空；含 items 明细+分类+报销人+审批人+打款人）
 * POST 创建报销单（DRAFT；可带 items 数组一次性创建报销单+多条明细；
 *      创建人即报销人 payee；仅项目成员或财务部/ADMIN；项目归档后禁止）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, okPage, created, parsePagination, requireAuth, ApiError } from '@/lib/api-helpers'
import { visibleExpenseClaimScope, isExpenseFinanceViewer } from '@/lib/data-visibility'
import {
  CLAIM_INCLUDE,
  serializeClaim,
  validateCategoryIds,
  parseExpenseDate,
  sumItemAmounts,
  assertTotalCap,
  MAX_ITEM_AMOUNT,
} from '@/app/api/expense-claims/_shared'
import type { Prisma } from '@prisma/client'
import { ExpenseStatus } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const itemInputSchema = z.object({
  categoryId: z.string().min(1, '请选择费用分类'),
  amount: z.number().positive('金额必须大于 0').max(MAX_ITEM_AMOUNT, '金额超出上限'),
  expenseDate: z.string().min(1, '请填写费用发生日期'),
  description: z.string().trim().max(500, '费用说明过长').optional().nullable(),
})

const createClaimSchema = z.object({
  remark: z.string().trim().max(500, '备注过长').optional().nullable(),
  items: z.array(itemInputSchema).max(100, '明细最多 100 条').optional().default([]),
})

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const { page, limit, skip } = parsePagination(request)
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const payeeId = searchParams.get('payeeId')

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  // ★ 可见性过滤（报销人本人 ∪ 财务部 ∪ ADMIN）
  const visibility = await visibleExpenseClaimScope(user.userId, user.role)

  // ★ P2-1：status 必须为合法枚举，非法值返回 400 而非 Prisma 报错 500
  if (status && !Object.values(ExpenseStatus).includes(status as ExpenseStatus)) {
    throw ApiError.badRequest(`无效的报销单状态筛选值：${status}`)
  }

  const where: Prisma.ExpenseClaimWhereInput = {
    projectId: id,
    ...visibility,
    ...(status && { status: status as ExpenseStatus }),
    ...(payeeId && { payeeId }),
  }

  const [claims, total] = await Promise.all([
    prisma.expenseClaim.findMany({
      where,
      include: CLAIM_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.expenseClaim.count({ where }),
  ])

  return okPage(claims.map(serializeClaim), page, limit, total)
})

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createClaimSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw ApiError.badRequest('项目已归档，无法创建报销单')

  // 权限：项目成员 或 财务部/ADMIN（财务/ADMIN 可代录，payee 仍为操作人本人）
  const [membership, finViewer] = await Promise.all([
    prisma.projectMember.findFirst({
      where: { projectId: id, userId: user.userId },
      select: { id: true },
    }),
    isExpenseFinanceViewer(user.userId, user.role),
  ])
  if (!membership && !finViewer) {
    throw ApiError.forbidden('仅项目成员或财务部/管理员可创建报销单')
  }

  // 校验全部明细分类与日期
  await validateCategoryIds(body.items.map((it) => it.categoryId))
  const parsedDates = body.items.map((it) => parseExpenseDate(it.expenseDate))

  // ★ Decimal 精确求和（总额=明细 sum），并校验总额上限
  const total = sumItemAmounts(body.items.map((it) => it.amount))
  assertTotalCap(total)

  // 事务：报销单 + 明细一次性落库（payee=创建人）
  const claim = await prisma.$transaction(async (tx) => {
    return tx.expenseClaim.create({
      data: {
        projectId: id,
        payeeId: user.userId,
        createdById: user.userId,
        status: 'DRAFT',
        totalAmount: total,
        remark: body.remark ?? null,
        items: {
          create: body.items.map((it, i) => ({
            categoryId: it.categoryId,
            amount: it.amount,
            expenseDate: parsedDates[i],
            description: it.description ?? null,
          })),
        },
      },
      include: CLAIM_INCLUDE,
    })
  })

  return created(serializeClaim(claim), '报销单草稿已保存')
})
