import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept, canViewPurchaseFinanceOf } from '@/lib/data-visibility'
import { z } from 'zod'

/**
 * /api/purchase-contracts —— ★ V3 采购合同（2026-08-22）
 *
 * GET  ?orderId=  某订单的合同（金额脱敏）
 * POST { orderId, contractNo?, supplierContractNo?, contractAmount?, deliveryTerms?, paymentTerms?, fileId? }
 *      登记合同（采购部/ADMIN）—— upsert 语义：已有则更新
 * PATCH body { orderId } + { action: 'CONFIRM' | 'VOID', ... } 合同确认/作废
 */

const contractSchema = z.object({
  orderId: z.string().min(1, '缺少订单 id'),
  contractNo: z.string().trim().optional(),
  supplierContractNo: z.string().trim().optional(),
  contractAmount: z.number().nonnegative().optional(),
  deliveryTerms: z.string().trim().optional(),
  paymentTerms: z.string().trim().optional(),
  fileId: z.string().optional(),
  remark: z.string().trim().optional(),
})

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get('orderId')
  if (!orderId) throw ApiError.badRequest('缺少 orderId 参数')

  const contract = await prisma.purchaseContract.findUnique({
    where: { orderId },
    include: {
      confirmedBy: { select: { id: true, name: true } },
      order: { select: { code: true, title: true, projectId: true } },
    },
  })
  if (!contract) return ok(null)

  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)
  if (!finOk) {
    return ok({
      ...contract,
      contractAmount: null,
      paymentTerms: null,
    })
  }
  return ok({ ...contract, contractAmount: contract.contractAmount != null ? Number(contract.contractAmount) : null })
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  // 仅采购部/ADMIN 可登记合同
  const deptName = await getUserDeptName(user.userId)
  if (user.role !== 'ADMIN' && !isPurchaseDept(deptName)) {
    throw ApiError.forbidden('仅采购部可登记合同')
  }
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = contractSchema.parse(raw)

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: body.orderId },
    select: { id: true, code: true, amount: true },
  })
  if (!order) throw ApiError.notFound('订单不存在')

  const result = await prisma.purchaseContract.upsert({
    where: { orderId: body.orderId },
    create: {
      orderId: body.orderId,
      contractNo: body.contractNo ?? order.code,
      supplierContractNo: body.supplierContractNo ?? null,
      contractAmount:
        body.contractAmount != null ? body.contractAmount : (order.amount != null ? Number(order.amount) : null),
      deliveryTerms: body.deliveryTerms ?? null,
      paymentTerms: body.paymentTerms ?? null,
      fileId: body.fileId ?? null,
      remark: body.remark ?? null,
      status: 'PENDING',
    },
    update: {
      contractNo: body.contractNo ?? undefined,
      supplierContractNo: body.supplierContractNo ?? undefined,
      contractAmount: body.contractAmount != null ? body.contractAmount : undefined,
      deliveryTerms: body.deliveryTerms ?? undefined,
      paymentTerms: body.paymentTerms ?? undefined,
      fileId: body.fileId ?? undefined,
      remark: body.remark ?? undefined,
    },
  })

  return created(result, '合同已登记（待采购确认）')
})
