import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept } from '@/lib/data-visibility'
import { orderNotifyTargets } from '@/lib/purchase-workflow'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

/**
 * /api/goods-arrivals/[id]/confirm —— ★ V3 收货人确认收货（2026-08-22，工作流第⑧步）
 *
 * POST body: { proofNote?, remark? }
 *   收货人（被指派 receiverId 本人 / 采购部 / ADMIN）确认收货：
 *   - confirmedById/confirmedAt 落库（留痕）
 *   - arrival.status → RECEIVED（或按明细 PARTIAL 保留）
 *   - 全部订单明细收齐 → 订单 COMPLETED；部分 → PARTIAL
 *   - 通知清单发布人（PURCHASE_RECEIVED）
 */

const confirmSchema = z.object({
  proofNote: z.string().trim().optional(), // 签收凭证（送货单号/照片说明）
  remark: z.string().trim().optional(),
})

export const POST = apiHandler(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = confirmSchema.parse(raw)

  const arrival = await prisma.goodsArrival.findUnique({
    where: { id: id },
    include: { order: { select: { id: true, code: true, title: true, projectId: true, status: true } } },
  })
  if (!arrival) throw ApiError.notFound('到货记录不存在')
  if (arrival.confirmedAt) throw ApiError.badRequest('该到货已确认过，请勿重复操作')

  // 权限：被指派收货人本人 / 采购部 / ADMIN（方案 §1.2「确认收货」行）
  const deptName = await getUserDeptName(user.userId)
  const isReceiver = arrival.receiverId === user.userId
  if (!isReceiver && user.role !== 'ADMIN' && !isPurchaseDept(deptName)) {
    throw ApiError.forbidden('仅被指派的收货人 / 采购部 / 管理员可确认收货')
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 确认留痕
    const updated = await tx.goodsArrival.update({
      where: { id: arrival.id },
      data: {
        confirmedById: user.userId,
        confirmedAt: new Date(),
        proofNote: body.proofNote ?? null,
        ...(body.remark ? { remark: body.remark } : {}),
        // 明细存在破损/拒收 → PARTIAL；否则 RECEIVED
        status: arrival.status === 'REJECTED' ? 'REJECTED' : arrival.status === 'PARTIAL' ? 'PARTIAL' : 'RECEIVED',
      },
    })

    // 订单状态推进：全部收齐 → COMPLETED；部分 → PARTIAL
    const items = await tx.purchaseOrderItem.findMany({
      where: { orderId: arrival.orderId },
      select: { quantity: true, receivedQty: true },
    })
    const allDone = items.length > 0 && items.every((it) => Number(it.receivedQty) >= Number(it.quantity))
    const order = await tx.purchaseOrder.findUnique({ where: { id: arrival.orderId }, select: { status: true } })
    if (order && order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
      await tx.purchaseOrder.update({
        where: { id: arrival.orderId },
        data: { status: allDone ? 'COMPLETED' : 'PARTIAL' },
      })
    }

    // ★ 2026-08-25 通知升级：发布人 ∪ 项目全体成员 ∪ ADMIN（确认收货闭环全员可见）
    const targets = await orderNotifyTargets(tx, arrival.orderId, arrival.order.projectId)
    targets.delete(user.userId)
    for (const uid of Array.from(targets)) {
      await tx.notification.create({
        data: {
          userId: uid,
          type: 'PURCHASE_RECEIVED',
          title: `已收货：${arrival.order.code}`,
          body: `到货批次「${arrival.batchNo}」已由${user.userId === arrival.receiverId ? '收货人' : '采购'}确认收货${allDone ? '，采购流程完成' : ''}`,
          link: `/purchase?orderId=${arrival.orderId}`,
        },
      })
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'notify:push',
        userId: uid,
        title: `已收货：${arrival.order.code}`,
        body: `到货批次「${arrival.batchNo}」已确认收货${allDone ? '，采购流程完成' : ''}`,
        link: `/purchase?orderId=${arrival.orderId}`,
      })})`
    }

    return { arrival: updated, orderCompleted: allDone }
  })

  return ok(
    { confirmedAt: result.arrival.confirmedAt, orderCompleted: result.orderCompleted },
    result.orderCompleted ? '收货已确认，采购流程全部完成' : '收货已确认',
  )
})
