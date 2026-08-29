/**
 * /api/expense-claims/[id]/items —— 报销单明细单条增/改/删（F2-R2）
 *
 * 可见性与 /api/expense-claims/[id] 同口径：报销人本人 + 财务部 + ADMIN；
 * 操作（增删改）仅限：DRAFT 状态 + 报销人本人 + 项目未归档。
 * 每次变动后自动重算报销单 totalAmount（= 明细 Decimal sum）。
 *
 * POST   { categoryId, amount, expenseDate, description? }  → 新增一条明细
 * PATCH  { itemId, categoryId?, amount?, expenseDate?, description? } → 修改一条明细
 * DELETE ?itemId=xxx → 删除一条明细
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  serializeClaim,
  loadVisibleClaim as loadVisible,
  isClaimOwner as isOwner,
  assertDraft,
  validateCategoryIds,
  parseExpenseDate,
  recalcTotalTx,
  MAX_ITEM_AMOUNT,
} from '@/app/api/expense-claims/_shared'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const addItemSchema = z.object({
  categoryId: z.string().min(1, '请选择费用分类'),
  amount: z.number().positive('金额必须大于 0').max(MAX_ITEM_AMOUNT, '金额超出上限'),
  expenseDate: z.string().min(1, '请填写费用发生日期'),
  description: z.string().trim().max(500, '费用说明过长').optional().nullable(),
})

const patchItemSchema = z.object({
  itemId: z.string().min(1, '缺少明细 itemId'),
  categoryId: z.string().min(1).optional(),
  amount: z.number().positive('金额必须大于 0').max(MAX_ITEM_AMOUNT).optional(),
  expenseDate: z.string().min(1).optional(),
  description: z.string().trim().max(500).optional().nullable(),
})

/** 编辑类操作的统一前置校验：可见 → 报销人本人 → DRAFT → 项目未归档 */
async function loadEditableClaim(claimId: string, userId: string, role: string) {
  const { claim } = await loadVisible(claimId, userId, role)
  if (!isOwner(claim, userId)) throw ApiError.forbidden('仅报销人可编辑报销单明细')
  assertDraft(claim.status)
  if (claim.project.isArchived) throw ApiError.badRequest('项目已归档，报销单不可编辑')
  return claim
}

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await loadEditableClaim(id, user.userId, user.role)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = addItemSchema.parse(raw)

  await validateCategoryIds([body.categoryId])
  const expenseDate = parseExpenseDate(body.expenseDate)

  const claim = await prisma.$transaction(async (tx) => {
    await tx.expenseItem.create({
      data: {
        claimId: id,
        categoryId: body.categoryId,
        amount: body.amount,
        expenseDate,
        description: body.description ?? null,
      },
    })
    return recalcTotalTx(tx, id)
  })

  return created(serializeClaim(claim), '费用明细已添加')
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await loadEditableClaim(id, user.userId, user.role)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchItemSchema.parse(raw)

  // 明细必须属于本报销单（防跨单越权改他人明细）
  const item = await prisma.expenseItem.findFirst({
    where: { id: body.itemId, claimId: id },
    select: { id: true },
  })
  if (!item) throw ApiError.notFound('费用明细不存在')

  if (
    body.categoryId === undefined &&
    body.amount === undefined &&
    body.expenseDate === undefined &&
    body.description === undefined
  ) {
    throw ApiError.badRequest('没有可更新的字段')
  }
  if (body.categoryId !== undefined) await validateCategoryIds([body.categoryId])

  const data: Record<string, unknown> = {}
  if (body.categoryId !== undefined) data.categoryId = body.categoryId
  if (body.amount !== undefined) data.amount = body.amount
  if (body.expenseDate !== undefined) data.expenseDate = parseExpenseDate(body.expenseDate)
  if (body.description !== undefined) data.description = body.description ?? null

  const claim = await prisma.$transaction(async (tx) => {
    await tx.expenseItem.update({ where: { id: item.id }, data })
    return recalcTotalTx(tx, id)
  })

  return ok(serializeClaim(claim), '费用明细已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await loadEditableClaim(id, user.userId, user.role)

  const { searchParams } = new URL(request.url)
  const itemId = searchParams.get('itemId')
  if (!itemId) throw ApiError.badRequest('缺少明细 itemId 参数')

  const item = await prisma.expenseItem.findFirst({
    where: { id: itemId, claimId: id },
    select: { id: true },
  })
  if (!item) throw ApiError.notFound('费用明细不存在')

  const claim = await prisma.$transaction(async (tx) => {
    await tx.expenseItem.delete({ where: { id: item.id } })
    return recalcTotalTx(tx, id)
  })

  return ok(serializeClaim(claim), '费用明细已删除')
})
