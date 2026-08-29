import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { canAdvance, ADVANCE_ACTIONS, ORDER_TRANSITIONS, notifyOrderAdvanced, recalcPaidAmount } from '@/lib/purchase-workflow'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'

/**
 * /api/purchase-orders/[id]/advance —— ★ V3 状态推进统一入口（2026-08-22）
 *
 * PATCH body: { action, contract?: {...}, payment?: {...}, shippingNote?, remark? }
 *   action ∈ START_CONTRACT | CONFIRM_CONTRACT | PLACE_ORDER | MARK_PREPARING | MARK_SHIPPED | CANCEL
 *
 * 白名单校验（ORDER_TRANSITIONS）+ 操作者权限（采购部/财务/ADMIN）+ 前置条件 +
 * 副作用（生成合同/付款回写/发货时间）+ 事务内通知发布人。
 */

const advanceSchema = z.object({
  action: z.enum(['START_CONTRACT', 'CONFIRM_CONTRACT', 'PLACE_ORDER', 'MARK_PREPARING', 'MARK_SHIPPED', 'CANCEL']),
  remark: z.string().trim().optional(),
  shippingNote: z.string().trim().optional(),
  // START_CONTRACT / CONFIRM_CONTRACT：合同字段
  contract: z
    .object({
      contractNo: z.string().trim().optional(),
      supplierContractNo: z.string().trim().optional(),
      contractAmount: z.number().nonnegative().optional(),
      deliveryTerms: z.string().trim().optional(),
      paymentTerms: z.string().trim().optional(),
      fileId: z.string().optional(),
    })
    .optional(),
  // MARK_PREPARING：可同时登记付款
  payment: z
    .object({
      type: z.enum(['PREPAYMENT', 'FULL', 'TAIL', 'REFUND']),
      amount: z.number().positive(),
      method: z.string().trim().optional(),
      voucherNo: z.string().trim().optional(),
      invoiceNo: z.string().trim().optional(),
      paidAt: z.string().optional(),
      remark: z.string().trim().optional(),
    })
    .optional(),
})

export const PATCH = apiHandler(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = advanceSchema.parse(raw)

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: id },
    include: { items: { select: { id: true } }, contract: true },
  })
  if (!order) throw ApiError.notFound('订单不存在')

  // ★ 权限：action 级角色校验（采购部/财务/ADMIN）
  if (!(await canAdvance(user.userId, user.role, body.action))) {
    throw ApiError.forbidden('仅采购部（付款可财务部）可执行该操作')
  }

  // ★ 白名单：from → to 合法性
  const def = ADVANCE_ACTIONS[body.action]
  if (!ORDER_TRANSITIONS[order.status].includes(def.to)) {
    throw ApiError.badRequest(
      `当前状态「${order.status}」不允许推进到「${def.to}」（合法目标：${ORDER_TRANSITIONS[order.status].join('/') || '无'}）`,
    )
  }

  // ★ 前置校验（per action，方案 §3.2）
  switch (body.action) {
    case 'START_CONTRACT': {
      if (!order.supplierId) throw ApiError.badRequest('发起合同前必须先绑定供应商')
      if (order.items.length === 0) throw ApiError.badRequest('订单无明细，无法发起合同')
      break
    }
    case 'CONFIRM_CONTRACT': {
      if (!order.contract) throw ApiError.badRequest('尚未登记合同，无法确认（请先「发起合同」）')
      break
    }
    case 'PLACE_ORDER': {
      if (!order.contract || order.contract.status !== 'CONFIRMED') {
        throw ApiError.badRequest('正式下单前必须先确认合同（合同状态须为 CONFIRMED）')
      }
      break
    }
    case 'MARK_SHIPPED': {
      if (Number(order.paidAmount ?? 0) <= 0) {
        throw ApiError.badRequest('登记发货前必须已登记付款（供应商收款后才备货发货）')
      }
      break
    }
    case 'CANCEL': {
      if (!body.remark || !body.remark.trim()) {
        throw ApiError.badRequest('取消/作废必须填写原因（remark）')
      }
      break
    }
    default:
      break
  }

  // ★ 事务：状态推进 + 副作用 + 通知
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const from = order.status
    const to = def.to
    const now = new Date()

    // 状态推进 + action 副作用
    const updateData: Prisma.PurchaseOrderUpdateInput = { status: to }

    // 合同处理
    if (body.action === 'START_CONTRACT') {
      // 生成/更新合同（PENDING 待供应商确认→采购确认）
      const c = body.contract ?? {}
      await tx.purchaseContract.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          contractNo: c.contractNo ?? order.code,
          supplierContractNo: c.supplierContractNo ?? null,
          contractAmount: c.contractAmount != null ? c.contractAmount : (order.amount != null ? Number(order.amount) : null),
          deliveryTerms: c.deliveryTerms ?? null,
          paymentTerms: c.paymentTerms ?? null,
          fileId: c.fileId ?? null,
          status: 'PENDING',
        },
        update: {
          contractNo: c.contractNo ?? undefined,
          supplierContractNo: c.supplierContractNo ?? undefined,
          contractAmount: c.contractAmount != null ? c.contractAmount : undefined,
          deliveryTerms: c.deliveryTerms ?? undefined,
          paymentTerms: c.paymentTerms ?? undefined,
          fileId: c.fileId ?? undefined,
          status: 'PENDING',
        },
      })
    }
    if (body.action === 'CONFIRM_CONTRACT' && order.contract) {
      const c = body.contract ?? {}
      await tx.purchaseContract.update({
        where: { id: order.contract.id },
        data: {
          ...(Object.keys(c).length > 0
            ? {
                contractNo: c.contractNo ?? undefined,
                supplierContractNo: c.supplierContractNo ?? undefined,
                contractAmount: c.contractAmount != null ? c.contractAmount : undefined,
                deliveryTerms: c.deliveryTerms ?? undefined,
                paymentTerms: c.paymentTerms ?? undefined,
                fileId: c.fileId ?? undefined,
              }
            : {}),
          status: 'CONFIRMED',
          confirmedAt: now,
          confirmedById: user.userId,
        },
      })
    }
    if (body.action === 'PLACE_ORDER') {
      updateData.orderDate = now
    }
    if (body.action === 'MARK_PREPARING' && body.payment) {
      // 同时登记付款流水
      await tx.purchasePayment.create({
        data: {
          orderId: order.id,
          type: body.payment.type,
          amount: body.payment.amount,
          status: 'PAID',
          paidAt: body.payment.paidAt ? new Date(body.payment.paidAt) : now,
          method: body.payment.method ?? null,
          voucherNo: body.payment.voucherNo ?? null,
          invoiceNo: body.payment.invoiceNo ?? null,
          createdById: user.userId,
          remark: body.payment.remark ?? null,
        },
      })
      await recalcPaidAmount(tx, order.id)
    }
    if (body.action === 'MARK_SHIPPED') {
      updateData.shippedAt = now
      updateData.shippingNote = body.shippingNote ?? undefined
    }
    if (body.action === 'CANCEL') {
      if (order.contract) {
        await tx.purchaseContract.update({
          where: { id: order.contract.id },
          data: { status: 'VOIDED', voidReason: body.remark ?? null },
        })
      }
      if (body.remark) updateData.remark = body.remark
    }
    if (body.remark && body.action !== 'CANCEL') {
      updateData.remark = body.remark
    }

    const updated = await tx.purchaseOrder.update({
      where: { id: order.id },
      data: updateData,
    })

    // ★ 通知（事务内 pg_notify，回滚不发出）
    await notifyOrderAdvanced(tx, order, from, to)

    return { status: to, paidAmount: Number(updated.paidAmount ?? 0) }
  })

  return ok(result, `订单 ${order.code} 已推进为「${ADVANCE_ACTIONS[body.action].label}」`)
})
