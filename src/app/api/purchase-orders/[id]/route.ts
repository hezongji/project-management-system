/**
 * /api/purchase-orders/[id] —— 订单详情/流转
 *
 * GET    详情（items + arrivals 时间线 + 到货进度汇总）；可见性同列表口径（scope 过滤）
 * PATCH  DRAFT 可改（采购部/创建人|owner/ADMIN）；状态流转：
 *          - order：DRAFT→ORDERED（下单，orderDate=now）
 *          - cancel：DRAFT/ORDERED/PARTIAL→CANCELLED
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  visiblePurchaseOrderFilter,
  getUserDeptName,
  isPurchaseDept,
  canViewPurchaseFinanceOf,
  maskPurchaseFinance,
} from '@/lib/data-visibility'
import { assertDeletable, logDelete } from '@/lib/delete-helpers'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  // DRAFT 编辑字段
  title: z.string().trim().min(1).optional(),
  category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
  supplierId: z.string().optional().nullable(),
  plannedArrivalDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        spec: z.string().trim().optional().nullable(),
        param: z.string().trim().optional().nullable(), // ★ 2026-08-25 字段统一
        brand: z.string().trim().optional().nullable(),
        quantity: z.number().positive(),
        unit: z.string().trim().min(1).default('件'),
        unitPrice: z.number().nonnegative().optional().nullable(),
        remark: z.string().trim().optional().nullable(),
      }),
    )
    .optional(), // 全量替换明细
  // 流转动作
  action: z.enum(['order', 'cancel']).optional(),
})

export const GET = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  // 可见性（★ Step3 修复 S2 评审 B2）：详情与列表同口径——统一走 visiblePurchaseOrderFilter
  // （ADMIN/采购部全量；其余=creator/owner/receiver/发布人链路/被授权），不可见=不可达
  const visibility = await visiblePurchaseOrderFilter(user.userId, user.role)
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: id, ...visibility },
    include: {
      project: { select: { id: true, code: true, name: true } },
      supplier: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      supplementaryOf: { select: { id: true, code: true, title: true } },
      supplierRequests: { select: { id: true, code: true, brand: true }, orderBy: { code: 'asc' } },
      items: true,
      arrivals: {
        include: {
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: true,
        },
        orderBy: { arrivalDate: 'desc' },
      },
    },
  })
  if (!order) throw ApiError.notFound('采购订单不存在')

  // 金额脱敏（★ V3：去 OWNER/MANAGER 默认，改 purchaseFinanceGranted 授权）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  // 进度汇总：下单总量 / 已到货量 / 明细到齐数
  const totalQty = order.items.reduce((s, it) => s + Number(it.quantity), 0)
  const receivedQty = order.items.reduce((s, it) => s + Number(it.receivedQty), 0)
  const itemsDone = order.items.filter(
    (it) => Number(it.receivedQty) >= Number(it.quantity),
  ).length

  // ★ Step3：统一走 maskPurchaseFinance（修复 paidAmount 泄露，含明细行 unitPrice）
  const payload = {
    ...order,
    amount: order.amount != null ? Number(order.amount) : null,
    settlementAmount: order.settlementAmount != null ? Number(order.settlementAmount) : null,
    paidAmount: order.paidAmount != null ? Number(order.paidAmount) : null,
    progress: {
      totalQty,
      receivedQty,
      itemsTotal: order.items.length,
      itemsDone,
      percent: totalQty > 0 ? Math.round((receivedQty / totalQty) * 100) : 0,
    },
    items: order.items.map((it) =>
      maskPurchaseFinance(
        {
          ...it,
          quantity: Number(it.quantity),
          receivedQty: Number(it.receivedQty),
          unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null,
        },
        finOk,
      ),
    ),
    arrivals: order.arrivals.map((a) => ({
      ...a,
      items: a.items.map((ai) => ({
        ...ai,
        arrivedQty: Number(ai.arrivedQty),
        defectQty: Number(ai.defectQty),
        rejectQty: Number(ai.rejectQty),
      })),
    })),
  }
  return ok(maskPurchaseFinance(payload, finOk))
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchSchema.parse(raw)

  const existing = await prisma.purchaseOrder.findUnique({
    where: { id: id },
    select: { id: true, status: true, projectId: true, creatorId: true, ownerId: true },
  })
  if (!existing) throw ApiError.notFound('采购订单不存在')

  // 编辑权限：采购部 / 创建人|owner / ADMIN（DRAFT 编辑）；流转同权限
  let isWriter = user.role === 'ADMIN'
  if (!isWriter) {
    const deptName = await getUserDeptName(user.userId)
    if (isPurchaseDept(deptName)) isWriter = true
  }
  if (!isWriter && (existing.creatorId === user.userId || existing.ownerId === user.userId)) {
    isWriter = true
  }
  if (!isWriter) throw ApiError.forbidden('无权操作该采购订单')

  const data: Record<string, unknown> = {}

  // ★ V3：状态推进统一走 /advance（白名单+权限+通知）；此处仅保留 cancel 兼容与字段编辑
  if (body.action === 'order') {
    throw ApiError.badRequest('下单请使用状态推进接口（advance/PLACE_ORDER），需先确认合同')
  } else if (body.action === 'cancel') {
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw ApiError.badRequest(`当前状态 ${existing.status} 不可取消`)
    }
    data.status = 'CANCELLED'
  }

  // DRAFT 编辑字段 + 明细替换
  const editable =
    existing.status === 'DRAFT' &&
    (isWriter || existing.creatorId === user.userId)
  if (editable && !body.action) {
    if (body.title !== undefined) data.title = body.title
    if (body.category !== undefined) data.category = body.category
    if (body.supplierId !== undefined) {
      if (body.supplierId) {
        const supplier = await prisma.externalOrg.findUnique({
          where: { id: body.supplierId },
          select: { id: true, type: true },
        })
        if (!supplier || supplier.type !== 'SUPPLIER') {
          throw ApiError.badRequest('供应商不存在或类型不是 SUPPLIER')
        }
      }
      data.supplierId = body.supplierId
    }
    if (body.plannedArrivalDate !== undefined) {
      data.plannedArrivalDate = body.plannedArrivalDate ? new Date(body.plannedArrivalDate) : null
    }
    if (body.remark !== undefined) data.remark = body.remark
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (body.items && editable && !body.action) {
      await tx.purchaseOrderItem.deleteMany({ where: { orderId: existing.id } })
      await tx.purchaseOrderItem.createMany({
        data: body.items.map((it) => ({
          orderId: existing.id,
          name: it.name,
          spec: it.spec ?? null,
          param: it.param ?? null,
          brand: it.brand ?? null,
          quantity: it.quantity,
          unit: it.unit,
          unitPrice: it.unitPrice ?? null,
          remark: it.remark ?? null,
        })),
      })
      // 重算总额
      const amount = body.items.reduce((sum, it) => sum + it.quantity * (it.unitPrice ?? 0), 0)
      data.amount = amount > 0 ? amount : null
    }
    if (Object.keys(data).length > 0) {
      await tx.purchaseOrder.update({ where: { id: existing.id }, data })
    }
    return tx.purchaseOrder.findUnique({
      where: { id: existing.id },
      include: {
        items: true,
        supplier: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
      },
    })
  })

  return ok(updated, body.action === 'cancel' ? '订单已取消' : '订单已更新')
})

/**
 * DELETE 删除采购订单（删除工程第 6 棒 · 采购域；确认时本文件原无 DELETE，按任务书补齐）
 *
 * 双闸：① 可见性闸 visiblePurchaseOrderFilter（与 GET/列表同口径，不可见=404）
 *       ② 写权限闸（与 PATCH 同口径：ADMIN / 采购部 / creator|owner → 否则 403）
 * 状态闸：仅 DRAFT 可删（schema 枚举注释即「草稿未下单，可编辑/删除」）；其余 → 400 提示改用取消。
 * 引用保护（assertDeletable）：追加单指向本单（supplementaryItems）、已确认到货（非 PENDING）、付款流水 → 400 拒删。
 * 级联处理（同一事务）：
 *   - SupplierRequest 解链：orderId=null + 状态回退（ORDERED→QUOTED/PUBLISHED，无报价则回 PUBLISHED）
 *   - 未确认到货 GoodsArrival(PENDING)（及其明细随 FK 级联）→ 删除
 *   - PurchaseOrderItem → 删除
 *   - PurchaseContract（草稿期登记的待确认合同）→ 删除
 * 审计：logDelete（purchaseOrder.delete）。
 */
export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  // 闸①：可见性（与 GET 同口径），不可见 = 404
  const visibility = await visiblePurchaseOrderFilter(user.userId, user.role)
  const existing = await prisma.purchaseOrder.findFirst({
    where: { id: id, ...visibility },
    select: {
      id: true,
      code: true,
      status: true,
      projectId: true,
      creatorId: true,
      ownerId: true,
      contract: { select: { id: true, status: true } },
      supplierRequests: { select: { id: true, code: true, status: true, quotedAt: true }, orderBy: { code: 'asc' } },
      _count: { select: { supplementaryItems: true, items: true, payments: true } },
    },
  })
  if (!existing) throw ApiError.notFound('采购订单不存在')

  // 闸②：写权限（与 PATCH 完全同口径：ADMIN / 采购部 / creator|owner）
  let isWriter = user.role === 'ADMIN'
  if (!isWriter) {
    const deptName = await getUserDeptName(user.userId)
    if (isPurchaseDept(deptName)) isWriter = true
  }
  if (!isWriter && (existing.creatorId === user.userId || existing.ownerId === user.userId)) {
    isWriter = true
  }
  if (!isWriter) throw ApiError.forbidden('无权删除该采购订单')

  // 状态闸：仅草稿可删（已进入流转/取消的保留历史，改用「取消」）
  if (existing.status !== 'DRAFT') {
    throw ApiError.badRequest(
      `仅草稿状态可删除；当前状态 ${existing.status} 已进入流转，请改用「取消」保留历史`,
    )
  }

  // 引用保护：①追加单指向本单（多退少补链路，不可断链）
  assertDeletable(existing._count.supplementaryItems, '该订单')
  // ②付款流水（财务记录，不可随草稿静默删除）
  assertDeletable(existing._count.payments, '该订单')
  // ③已确认到货（RECEIVED/PARTIAL/REJECTED 留实物/验收痕迹；未确认 PENDING 在事务中级联删）
  const confirmedArrivals = await prisma.goodsArrival.count({
    where: { orderId: existing.id, status: { not: 'PENDING' } },
  })
  assertDeletable(confirmedArrivals, '该订单')

  // 事务级联：解链需求 → 未确认到货 → 明细 → 草稿合同 → 本体
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1) SupplierRequests 解链（★ 1:N：可能多张品牌任务合并于本单）：DRAFT 单删后回退可重转
    let srDetached: string | null = null
    const srCodesReverted: Array<{ code: string; to: string | null }> = []
    for (const sr of existing.supplierRequests) {
      const reverted =
        sr.status === 'ORDERED'
          ? sr.quotedAt != null
            ? 'QUOTED'
            : 'PUBLISHED'
          : null
      await tx.supplierRequest.update({
        where: { id: sr.id },
        data: { orderId: null, ...(reverted ? { status: reverted } : {}) },
      })
      srCodesReverted.push({ code: sr.code, to: reverted })
      srDetached = srDetached ? `${srDetached}, ${sr.code}` : sr.code
    }

    // 2) 未确认到货（在途登记）→ 删除（GoodsArrivalItem 随 FK 级联）
    const arrivals = await tx.goodsArrival.deleteMany({
      where: { orderId: existing.id, status: 'PENDING' },
    })

    // 3) 订单明细 → 删除（此时已无到货明细引用）
    const items = await tx.purchaseOrderItem.deleteMany({ where: { orderId: existing.id } })

    // 4) 草稿期登记的合同（1:1）→ 仅删 PENDING 未确认合同；CONFIRMED/VOIDED 拒绝删除（m11：防脏数据静默丢已确认合同痕迹）
    const confirmedContract = await tx.purchaseContract.findFirst({
      where: { orderId: existing.id, status: { in: ['CONFIRMED', 'VOIDED'] } },
    })
    if (confirmedContract) {
      throw ApiError.badRequest(
        `订单存在${confirmedContract.status === 'CONFIRMED' ? '已确认' : '已作废'}合同（${confirmedContract.contractNo}），请走合同作废流程，勿删除订单`,
      )
    }
    const contracts = await tx.purchaseContract.deleteMany({
      where: { orderId: existing.id, status: 'PENDING' },
    })

    // 5) 本体
    await tx.purchaseOrder.delete({ where: { id: existing.id } })

    return {
      supplierRequestDetached: srDetached,
      supplierRequestsReverted: srCodesReverted,
      deletedPendingArrivals: arrivals.count,
      deletedItems: items.count,
      deletedContracts: contracts.count,
    }
  })

  await logDelete(
    user.userId,
    'purchaseOrder',
    existing.id,
    {
      code: existing.code,
      status: existing.status,
      projectId: existing.projectId,
      ...result,
    },
    existing.projectId,
  )

  return ok({ id: existing.id, ...result }, '采购订单已删除')
})
