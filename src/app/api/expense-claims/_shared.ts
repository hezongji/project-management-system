/**
 * 报销单 API 共享工具（F2-R2 报销单+明细重构 2026-08-24）
 *
 * 仅供 /api/expense-claims/** 与 /api/projects/[id]/expense-claims/** 路由使用。
 * 文件名下划线前缀 → Next.js 不作为路由暴露。
 */

import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isFinanceDept, canViewExpenseClaim } from '@/lib/data-visibility'
import { Prisma } from '@prisma/client'

/** 报销单统一 include（详情/列表/操作返回同构：明细+分类+报销人+审批人+打款人） */
export const CLAIM_INCLUDE = {
  items: {
    include: { category: { select: { id: true, name: true, code: true } } },
    orderBy: { expenseDate: 'desc' as const },
  },
  payee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  paidBy: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true, isArchived: true } },
} satisfies Prisma.ExpenseClaimInclude

export type ClaimWithItems = Prisma.ExpenseClaimGetPayload<{ include: typeof CLAIM_INCLUDE }>

/** 序列化：Decimal → Number（totalAmount / items[].amount） */
export function serializeClaim(claim: ClaimWithItems) {
  return {
    ...claim,
    totalAmount: Number(claim.totalAmount),
    items: claim.items.map((it) => ({ ...it, amount: Number(it.amount) })),
  }
}

/**
 * 加载报销单 + 可见性校验（★ 核心安全要求）：
 * 不存在 → 404；存在但不可见（非报销人本人/财务部/ADMIN）→ 403（与列表过滤同口径）
 */
export async function loadVisibleClaim(id: string, userId: string, role: string) {
  const [claim, deptName] = await Promise.all([
    prisma.expenseClaim.findUnique({ where: { id }, include: CLAIM_INCLUDE }),
    getUserDeptName(userId),
  ])
  if (!claim) throw ApiError.notFound('报销单不存在')
  const isFinance = isFinanceDept(deptName)
  if (!canViewExpenseClaim(claim, userId, role, isFinance)) {
    throw ApiError.forbidden('无权访问该报销单')
  }
  return { claim, isFinance }
}

/** 是否报销单本人（payeeId 或 createdById == 当前用户） */
export function isClaimOwner(claim: { payeeId: string; createdById: string }, userId: string): boolean {
  return claim.payeeId === userId || claim.createdById === userId
}

/** 明细/编辑操作仅限 DRAFT 状态 */
export function assertDraft(status: string): void {
  if (status !== 'DRAFT') {
    throw ApiError.badRequest(`当前状态 ${status} 不可编辑明细，仅草稿状态可修改（驳回单请先执行重新编辑）`)
  }
}

/** 校验费用发生日期格式（无效 → 400） */
export function parseExpenseDate(value: string): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest('费用发生日期格式无效')
  return d
}

/** 批量校验分类 id 全部存在且启用（否则 400） */
export async function validateCategoryIds(categoryIds: string[]): Promise<void> {
  const unique = Array.from(new Set(categoryIds))
  if (unique.length === 0) return
  const found = await prisma.expenseCategory.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true },
  })
  if (found.length !== unique.length) {
    throw ApiError.badRequest('存在无效或已停用的费用分类')
  }
}

/** 单条明细金额上限（与 schema Decimal(12,2) 匹配） */
export const MAX_ITEM_AMOUNT = 9999999999.99

/** Decimal 精确求和（避免 JS Number 浮点累加尾差） */
export function sumItemAmounts(amounts: number[]): Prisma.Decimal {
  return amounts.reduce(
    (acc, a) => acc.plus(new Prisma.Decimal(a)),
    new Prisma.Decimal(0)
  )
}

/** 校验报销单总额不超 Decimal(12,2) 上限 */
export function assertTotalCap(total: Prisma.Decimal): void {
  if (total.greaterThan(new Prisma.Decimal(MAX_ITEM_AMOUNT))) {
    throw ApiError.badRequest('报销单总金额超出上限')
  }
}

/** 事务内按明细重算 totalAmount 并写回报销单，返回带 include 的最新报销单 */
export async function recalcTotalTx(
  tx: Prisma.TransactionClient,
  claimId: string
): Promise<ClaimWithItems> {
  const agg = await tx.expenseItem.aggregate({
    where: { claimId },
    _sum: { amount: true },
  })
  const total = agg._sum.amount ?? new Prisma.Decimal(0)
  assertTotalCap(total)
  return tx.expenseClaim.update({
    where: { id: claimId },
    data: { totalAmount: total },
    include: CLAIM_INCLUDE,
  })
}
