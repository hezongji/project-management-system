/**
 * /api/purchase-orders/[id]/arrivals —— 到货登记（分批多次收货）
 *
 * POST 采购部/PM(OWNER|MANAGER)/ADMIN：
 *   body: { batchNo?, arrivalDate?, supplierId?, status?, remark?,
 *           items: [{ orderItemId, arrivedQty, defectQty?, rejectQty?, remark? }] }
 *   事务：创建 GoodsArrival+Items → 回写 PurchaseOrderItem.receivedQty（+= arrivedQty）
 *         → 订单状态机（全部到齐 COMPLETED / 部分 PARTIAL）→ pg_notify 通知项目 OWNER
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept } from '@/lib/data-visibility'
import { nextArrivalBatchNo } from '@/lib/purchase-codes'
import { requireCan } from '@/lib/permission'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const arrivalSchema = z.object({
  batchNo: z.string().trim().optional(),
  arrivalDate: z
    .string()
    .refine(
      (v) => !Number.isNaN(Date.parse(v)),
      '到货日期格式不正确',
    )
    .optional(),
  supplierId: z.string().optional().nullable(),
  status: z.enum(['PENDING', 'RECEIVED', 'PARTIAL', 'REJECTED']).optional(),
  remark: z.string().trim().optional().nullable(),
  // ── ★ V3 新增：交货方式 + 收货人（2026-08-22）──
  deliveryType: z.enum(['TO_COMPANY', 'TO_CUSTOMER', 'SELF_PICKUP']).optional(),
  shippingAddress: z.string().trim().optional().nullable(), // 实际收货地址（TO_CUSTOMER 时填客户/工地地址）
  receiverId: z.string().optional().nullable(),              // 收货确认人（库房/现场，缺省=订单指派人）
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1, '缺少订单明细 id'),
        arrivedQty: z.number().nonnegative('实到数量不能为负'),
        defectQty: z.number().nonnegative().optional(),
        rejectQty: z.number().nonnegative().optional(),
        remark: z.string().trim().optional().nullable(),
      }),
    )
    .min(1, '至少一条到货明细'),
})

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = arrivalSchema.parse(raw)

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: id },
    select: {
      id: true,
      code: true,
      title: true,
      projectId: true,
      supplierId: true,
      status: true,
      receiverId: true,
    },
  })

  if (!order) throw ApiError.notFound('采购订单不存在')
  const project = await prisma.project.findUnique({
    where: { id: order.projectId },
    select: { code: true, isArchived: true },
  })

  // 权限：采购部 / ADMIN / 项目 edit（OWNER|MANAGER）
  if (user.role !== 'ADMIN') {
    const deptName = await getUserDeptName(user.userId)
    if (!isPurchaseDept(deptName)) {
      await requireCan(user.userId, 'edit', { type: 'PROJECT', id: order.projectId })
    }
  }
  if (order.status === 'DRAFT') throw ApiError.badRequest('草稿订单不能登记到货，请先下单')
  if (order.status === 'CANCELLED') throw ApiError.badRequest('已取消订单不能登记到货')

  // 校验明细归属
  const orderItems = await prisma.purchaseOrderItem.findMany({
    where: { orderId: order.id },
    select: { id: true, quantity: true, receivedQty: true, name: true },
  })
  const itemMap = new Map(orderItems.map((it) => [it.id, it]))
  for (const ai of body.items) {
    if (!itemMap.has(ai.orderItemId)) {
      throw ApiError.badRequest(`订单明细 ${ai.orderItemId} 不属于该订单`)
    }
  }

  const notifyOwnerAndReturn = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // 批次号默认 {orderCode}-{seq}（统一走 purchase-codes：序号不回退不复用，手动改号后仍递增）
      const batchNo =
        body.batchNo?.trim() ||
        (await nextArrivalBatchNo(tx, order.id, order.code))

      // 到货状态：显式指定优先；有破损/拒收 → PARTIAL；否则 RECEIVED
      const hasDefect = body.items.some(
        (ai) => (ai.defectQty ?? 0) > 0 || (ai.rejectQty ?? 0) > 0,
      )
      const arrivalStatus =
        body.status ?? (hasDefect ? 'PARTIAL' : 'RECEIVED')

      const arrival = await tx.goodsArrival.create({
        data: {
          projectId: order.projectId,
          orderId: order.id,
          batchNo,
          supplierId: body.supplierId ?? null,
          arrivalDate: body.arrivalDate ? new Date(body.arrivalDate) : new Date(),
          status: arrivalStatus,
          remark: body.remark ?? null,
          createdById: user.userId,
          // ★ V3：交货方式 + 收货人（缺省继承订单指派）
          deliveryType: body.deliveryType ?? 'TO_COMPANY',
          shippingAddress: body.shippingAddress ?? null,
          receiverId: body.receiverId ?? order.receiverId ?? null,
          items: {
            create: body.items.map((ai) => ({
              orderItemId: ai.orderItemId,
              arrivedQty: ai.arrivedQty,
              defectQty: ai.defectQty ?? 0,
              rejectQty: ai.rejectQty ?? 0,
              remark: ai.remark ?? null,
            })),
          },
        },
        include: { items: true },
      })

      // 回写 receivedQty（+= arrivedQty；合格量口径：arrived - defect - reject 不在此扣减，
      // receivedQty 记「实到数量」，破损/拒收由 settlementAmount/成本汇总环节处理）
      for (const ai of body.items) {
        if (ai.arrivedQty > 0) {
          await tx.purchaseOrderItem.update({
            where: { id: ai.orderItemId },
            data: { receivedQty: { increment: ai.arrivedQty } },
          })
        }
      }

      // 订单状态机：全部明细 receivedQty >= quantity → COMPLETED；部分 > 0 → PARTIAL
      const freshItems = await tx.purchaseOrderItem.findMany({
        where: { orderId: order.id },
        select: { quantity: true, receivedQty: true },
      })
      const allDone =
        freshItems.length > 0 &&
        freshItems.every((it) => Number(it.receivedQty) >= Number(it.quantity))
      const anyReceived = freshItems.some((it) => Number(it.receivedQty) > 0)
      const newStatus = allDone ? 'COMPLETED' : anyReceived ? 'PARTIAL' : null
      if (newStatus && newStatus !== order.status) {
        await tx.purchaseOrder.update({
          where: { id: order.id },
          data: { status: newStatus },
        })
      }

      // 通知（★ V3：溯源发布人 + 项目 OWNER，pg_notify im_events）
      const sr = await tx.supplierRequest.findUnique({
        where: { orderId: order.id },
        select: { request: { select: { requesterId: true } } },
      })
      const notifyTargets = new Set<string>()
      if (sr?.request?.requesterId) notifyTargets.add(sr.request.requesterId)
      const owner = await tx.projectMember.findFirst({
        where: { projectId: order.projectId, role: 'OWNER' },
        select: { userId: true },
      })
      if (owner) notifyTargets.add(owner.userId)
      notifyTargets.delete(user.userId)
      for (const uid of Array.from(notifyTargets)) {
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'notify:push',
          userId: uid,
          title: `到货登记：${order.code}`,
          body: `订单「${batchNo}」已到货 ${body.items.length} 项物料${
            allDone ? '，全部到齐' : ''
          }`,
          link: `/purchase?orderId=${order.id}`,
        })})`
      }

      return { arrival, allDone }
    },
    { timeout: 30_000 },
  )

  return created(
    {
      arrival: {
        ...notifyOwnerAndReturn.arrival,
        items: notifyOwnerAndReturn.arrival.items.map((ai) => ({
          ...ai,
          arrivedQty: Number(ai.arrivedQty),
          defectQty: Number(ai.defectQty),
          rejectQty: Number(ai.rejectQty),
        })),
      },
      orderCompleted: notifyOwnerAndReturn.allDone,
    },
    notifyOwnerAndReturn.allDone ? '到货已登记，订单全部到齐' : '到货已登记',
  )
})
