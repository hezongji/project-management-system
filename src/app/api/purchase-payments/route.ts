import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept, canViewPurchaseFinanceOf } from '@/lib/data-visibility'
import { recalcPaidAmount } from '@/lib/purchase-workflow'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'

/**
 * /api/purchase-payments —— ★ V3 付款流水（2026-08-22）
 *
 * GET  ?orderId=  某订单付款列表（仅采购/财务/ADMIN 可见，商业机密）
 * POST { orderId, type, amount, method?, voucherNo?, invoiceNo?, paidAt?, remark?, status? }
 *      登记付款（采购部/财务部/ADMIN）；事务内回写 paidAmount
 */

const paymentSchema = z.object({
  orderId: z.string().min(1, '缺少订单 id'),
  type: z.enum(['PREPAYMENT', 'FULL', 'TAIL', 'REFUND']),
  amount: z.number().positive('金额必须大于 0'),
  status: z.enum(['PLANNED', 'PAID']).optional().default('PAID'),
  method: z.string().trim().optional(),
  voucherNo: z.string().trim().optional(),
  invoiceNo: z.string().trim().optional(),
  paidAt: z.string().optional(),
  remark: z.string().trim().optional(),
})

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get('orderId')
  if (!orderId) throw ApiError.badRequest('缺少 orderId 参数')

  // ★ 付款流水整体属商业机密：仅采购/财务/ADMIN（canViewPurchaseFinanceOf）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)
  if (!finOk) throw ApiError.forbidden('付款流水仅采购部/财务部/管理员可见')

  const payments = await prisma.purchasePayment.findMany({
    where: { orderId },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const paid = payments.reduce((s, p) => (p.type === 'REFUND' ? s - Number(p.amount) : s + Number(p.amount)), 0)
  return ok({
    items: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    paidAmount: paid,
  })
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  // 采购部/财务部/ADMIN 可登记付款
  const deptName = await getUserDeptName(user.userId)
  const isFinance = !!deptName && deptName.includes('财务')
  if (user.role !== 'ADMIN' && !isPurchaseDept(deptName) && !isFinance) {
    throw ApiError.forbidden('仅采购部/财务部可登记付款')
  }
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = paymentSchema.parse(raw)

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: body.orderId },
    select: { id: true, code: true },
  })
  if (!order) throw ApiError.notFound('订单不存在')

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const payment = await tx.purchasePayment.create({
      data: {
        orderId: body.orderId,
        type: body.type,
        amount: body.amount,
        status: body.status,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        method: body.method ?? null,
        voucherNo: body.voucherNo ?? null,
        invoiceNo: body.invoiceNo ?? null,
        createdById: user.userId,
        remark: body.remark ?? null,
      },
    })
    // 回写订单 paidAmount 冗余
    await recalcPaidAmount(tx, body.orderId)
    return payment
  })

  return created(result, '付款已登记')
})
