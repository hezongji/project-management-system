/**
 * /api/expense-claims/[id] —— 报销单详情/编辑/状态流转/删除（F2-R2）
 *
 * 可见性（★ 核心）：仅 报销人本人(payeeId/createdById==me) + 财务部 + ADMIN；
 *   其他人（含项目 OWNER/MANAGER/成员）→ 403，不可见即不可达。
 *
 * GET    详情（含明细+分类+报销人+审批人+打款人姓名；可见性校验）
 * PATCH  ① 无 action：编辑（仅 DRAFT 且报销人本人）——remark 可改；
 *        items 传全量数组做明细增删改（带 id=更新、不带 id=新增、缺失 id=删除），总额自动重算
 *        ② 带 action 状态流转（五步审批流）：
 *           submit  DRAFT     → SUBMITTED（报销人）
 *           approve SUBMITTED → APPROVED（仅 ADMIN）
 *           reject  SUBMITTED → REJECTED（仅 ADMIN，必填 rejectedReason）
 *           pay     APPROVED  → PAID（仅财务部）
 *           reedit  REJECTED  → DRAFT（报销人）
 *        ★ 涉权动作（approve/reject/pay）实时回查用户 role/isActive（JWT 30 天内可能已降级/停用）
 *        ★ 项目已归档后拒绝一切编辑/流转
 * DELETE 仅 DRAFT 且报销人本人
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  CLAIM_INCLUDE,
  serializeClaim,
  loadVisibleClaim as loadVisible,
  isClaimOwner as isOwner,
  assertDraft,
  validateCategoryIds,
  parseExpenseDate,
  sumItemAmounts,
  assertTotalCap,
  MAX_ITEM_AMOUNT,
} from '@/app/api/expense-claims/_shared'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const itemInputSchema = z.object({
  id: z.string().optional(), // 编辑时携带=更新已有明细；缺失/不属于本单=新增
  categoryId: z.string().min(1, '请选择费用分类'),
  amount: z.number().positive('金额必须大于 0').max(MAX_ITEM_AMOUNT, '金额超出上限'),
  expenseDate: z.string().min(1, '请填写费用发生日期'),
  description: z.string().trim().max(500, '费用说明过长').optional().nullable(),
})

const patchClaimSchema = z.object({
  action: z.enum(['submit', 'approve', 'reject', 'pay', 'reedit']).optional(),
  rejectedReason: z.string().trim().max(500, '驳回原因过长').optional(),
  remark: z.string().trim().max(500, '备注过长').optional().nullable(),
  items: z.array(itemInputSchema).max(100, '明细最多 100 条').optional(),
})

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const { claim } = await loadVisible(id, user.userId, user.role)
  return ok(serializeClaim(claim))
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchClaimSchema.parse(raw)

  // ★ P1-2：涉权动作（approve/reject 依赖 ADMIN、pay 依赖财务）实时回查用户
  //   role 与 isActive——JWT 有效期 30 天，被降级/停用的旧 token 不得继续越权审批/打款
  let effectiveRole = user.role
  if (body.action === 'approve' || body.action === 'reject' || body.action === 'pay') {
    const fresh = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { role: true, isActive: true },
    })
    if (!fresh || !fresh.isActive) {
      throw ApiError.forbidden('账号不存在或已被停用，无法执行该操作')
    }
    effectiveRole = fresh.role
  }

  // 统一可见性入口：不可见 → 403（优先于 404 泄露存在性）
  // 涉权动作用回查后的实时 role 做可见性判定，防降级 ADMIN 旧 token 全量可见
  const { claim, isFinance } = await loadVisible(id, user.userId, effectiveRole)

  // ★ P2-8：项目已归档 → 拒绝编辑/提交/审批/打款等一切流转
  if (claim.project.isArchived) {
    throw ApiError.badRequest('项目已归档，报销单不可编辑或流转')
  }

  const isSubmitter = isOwner(claim, user.userId)
  const isAdmin = effectiveRole === 'ADMIN'

  // ── ② 状态流转（五步审批流） ─────────────────────────────
  if (body.action) {
    const data: Record<string, unknown> = {}
    switch (body.action) {
      case 'submit': {
        if (!isSubmitter) throw ApiError.forbidden('仅报销人可提交报销单')
        if (claim.status !== 'DRAFT') {
          throw ApiError.badRequest(`当前状态 ${claim.status} 不可提交`)
        }
        // 提交前必须有明细（空单/零额单无审批意义）
        if (claim.items.length === 0) {
          throw ApiError.badRequest('报销单至少需要一条费用明细才能提交')
        }
        data.status = 'SUBMITTED'
        data.rejectedReason = null
        break
      }
      case 'approve': {
        if (!isAdmin) throw ApiError.forbidden('仅管理员可审批报销单')
        if (claim.status !== 'SUBMITTED') {
          throw ApiError.badRequest(`当前状态 ${claim.status} 不可审批`)
        }
        data.status = 'APPROVED'
        data.approvedById = user.userId
        data.approvedAt = new Date()
        break
      }
      case 'reject': {
        if (!isAdmin) throw ApiError.forbidden('仅管理员可驳回报销单')
        if (claim.status !== 'SUBMITTED') {
          throw ApiError.badRequest(`当前状态 ${claim.status} 不可驳回`)
        }
        if (!body.rejectedReason?.trim()) throw ApiError.badRequest('驳回必须填写原因')
        data.status = 'REJECTED'
        data.rejectedReason = body.rejectedReason.trim()
        break
      }
      case 'pay': {
        if (!isFinance) throw ApiError.forbidden('仅财务部可打款')
        if (claim.status !== 'APPROVED') {
          throw ApiError.badRequest(`当前状态 ${claim.status} 不可打款`)
        }
        data.status = 'PAID'
        data.paidById = user.userId
        data.paidAt = new Date()
        break
      }
      case 'reedit': {
        if (!isSubmitter) throw ApiError.forbidden('仅报销人可重新编辑')
        if (claim.status !== 'REJECTED') {
          throw ApiError.badRequest(`当前状态 ${claim.status} 不可重新编辑`)
        }
        data.status = 'DRAFT'
        data.rejectedReason = null
        break
      }
    }

    const updated = await prisma.expenseClaim.update({
      where: { id: claim.id },
      data,
      include: CLAIM_INCLUDE,
    })
    return ok(serializeClaim(updated), '报销单已更新')
  }

  // ── ① 编辑（仅 DRAFT 且报销人本人）：remark + items 全量同步 ──
  if (!isSubmitter) throw ApiError.forbidden('仅报销人可编辑报销单')
  assertDraft(claim.status)
  if (body.remark === undefined && body.items === undefined) {
    throw ApiError.badRequest('没有可更新的字段')
  }

  // items 全量同步：校验分类/日期/总额后，事务内 增+删+改 一致性落库
  const updated = await prisma.$transaction(async (tx) => {
    if (body.items !== undefined) {
      await validateCategoryIds(body.items.map((it) => it.categoryId))
      const parsedDates = body.items.map((it) => parseExpenseDate(it.expenseDate))
      const total = sumItemAmounts(body.items.map((it) => it.amount))
      assertTotalCap(total)

      const existingIds = claim.items.map((it) => it.id)
      const keepItems = body.items.filter((it) => it.id && existingIds.includes(it.id))
      const keepIdSet = new Set(keepItems.map((it) => it.id))
      const toDelete = existingIds.filter((id) => !keepIdSet.has(id))

      // 删除：不在提交集合中的已有明细
      if (toDelete.length > 0) {
        await tx.expenseItem.deleteMany({ where: { id: { in: toDelete } } })
      }
      // 更新：带 id 且属于本单的明细
      for (const it of keepItems) {
        await tx.expenseItem.update({
          where: { id: it.id as string },
          data: {
            categoryId: it.categoryId,
            amount: it.amount,
            expenseDate: parsedDates[body.items!.indexOf(it)],
            description: it.description ?? null,
          },
        })
      }
      // 新增：不带 id 或 id 不属于本单的明细
      const toCreate = body.items.filter((it) => !it.id || !existingIds.includes(it.id))
      if (toCreate.length > 0) {
        await tx.expenseItem.createMany({
          data: toCreate.map((it) => ({
            claimId: claim.id,
            categoryId: it.categoryId,
            amount: it.amount,
            expenseDate: parseExpenseDate(it.expenseDate),
            description: it.description ?? null,
          })),
        })
      }
      // 总额=明细 sum（Decimal 精确）
      await tx.expenseClaim.update({
        where: { id: claim.id },
        data: { totalAmount: total },
      })
    }

    return tx.expenseClaim.update({
      where: { id: claim.id },
      data: body.remark !== undefined ? { remark: body.remark ?? null } : {},
      include: CLAIM_INCLUDE,
    })
  })

  return ok(serializeClaim(updated), '报销单已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const { claim } = await loadVisible(id, user.userId, user.role)

  if (!isOwner(claim, user.userId)) throw ApiError.forbidden('仅报销人可删除报销单')
  if (claim.status !== 'DRAFT') throw ApiError.badRequest('仅草稿状态可删除')

  // 级联删除明细（schema onDelete: Cascade）
  await prisma.expenseClaim.delete({ where: { id: claim.id } })
  return ok({ id: claim.id }, '报销单草稿已删除')
})
