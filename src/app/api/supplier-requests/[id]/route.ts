/**
 * /api/supplier-requests/[id] —— 采购需求详情/流转
 *
 * GET    详情（含 items）；ADMIN/采购部/项目成员可见
 * PATCH  状态流转 DRAFT→PUBLISHED→QUOTED→ORDERED（采购部/ADMIN）：
 *          - publish：DRAFT→PUBLISHED
 *          - quote：→QUOTED（quoteAmount 必填 + items 单价可批量更新，quotedAt=now）
 *          - order：→ORDERED（必须带 orderId，订单需已存在且同项目）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  getUserDeptName,
  isPurchaseDept,
  visibleSupplierRequestScope,
  canViewPurchaseFinanceOf,
  maskPurchaseFinance,
} from '@/lib/data-visibility'
import { logDelete } from '@/lib/delete-helpers'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  action: z.enum(['publish', 'quote', 'order', 'cancel']).optional(),
  // QUOTED 录入
  quoteAmount: z.number().nonnegative().optional(),
  quoteNote: z.string().trim().optional().nullable(),
  // ORDERED 关联
  orderId: z.string().optional(),
  remark: z.string().trim().optional().nullable(),
})

export const GET = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  // ★ Step3：可见性统一走 visibleSupplierRequestScope（与列表同口径，不可见=不可达；
  // 替换原「任意 grant 行放行」的宽判定——单据授权只对授权单据生效）
  const visibility = await visibleSupplierRequestScope(user.userId, user.role)
  const sr = await prisma.supplierRequest.findFirst({
    where: { id: id, ...visibility },
    include: {
      supplier: { select: { id: true, name: true } },
      request: {
        select: { id: true, code: true, title: true, requesterId: true },
      },
      creator: { select: { id: true, name: true } },
      project: { select: { id: true, code: true, name: true } },
      order: { select: { id: true, code: true, status: true } },
      items: true,
    },
  })
  if (!sr) throw ApiError.notFound('采购需求不存在')

  // 金额脱敏（★ V3：去 OWNER/MANAGER 默认，改 purchaseFinanceGranted 授权；
  // Step3 统一走 maskPurchaseFinance，防手写清单漏字段）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  const payload = {
    ...sr,
    quoteAmount: sr.quoteAmount != null ? Number(sr.quoteAmount) : null,
    items: sr.items.map((it) =>
      maskPurchaseFinance(
        {
          ...it,
          quantity: Number(it.quantity),
          unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null,
        },
        finOk,
      ),
    ),
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

  // 流转操作仅采购部/ADMIN
  const deptName = await getUserDeptName(user.userId)
  const isPurchaser = isPurchaseDept(deptName) || user.role === 'ADMIN'

  const existing = await prisma.supplierRequest.findUnique({
    where: { id: id },
    select: { id: true, status: true, projectId: true, creatorId: true },
  })
  if (!existing) throw ApiError.notFound('采购需求不存在')

  const data: Record<string, unknown> = {}
  if (body.remark !== undefined) data.remark = body.remark

  if (body.action) {
    if (!isPurchaser) throw ApiError.forbidden('仅采购部可操作采购需求流转')

    switch (body.action) {
      case 'publish': {
        if (existing.status !== 'DRAFT') throw ApiError.badRequest('仅草稿状态可发布')
        data.status = 'PUBLISHED'
        break
      }
      case 'quote': {
        if (existing.status !== 'PUBLISHED' && existing.status !== 'DRAFT') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可录入报价`)
        }
        if (body.quoteAmount === undefined) throw ApiError.badRequest('报价必须填写金额')
        data.status = 'QUOTED'
        data.quoteAmount = body.quoteAmount
        data.quoteNote = body.quoteNote ?? null
        data.quotedAt = new Date()
        break
      }
      case 'order': {
        if (existing.status !== 'QUOTED' && existing.status !== 'PUBLISHED') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可转订单`)
        }
        // ★ V3：不带 orderId → 自动创建 DRAFT 订单（从任务明细生成，供应商继承）；
        //     带 orderId → 关联已有订单（同项目校验）
        if (!body.orderId) {
          const full = await prisma.supplierRequest.findUnique({
            where: { id: existing.id },
            include: { items: true, project: { select: { code: true } } },
          })
          if (!full) throw ApiError.notFound('采购任务不存在')
          const poPrefix = `CG-${full.project.code}-`
          const lastPo = await prisma.purchaseOrder.findFirst({
            where: { code: { startsWith: poPrefix } },
            orderBy: { code: 'desc' },
            select: { code: true },
          })
          const poSeq = lastPo ? parseInt(lastPo.code.slice(poPrefix.length), 10) + 1 : 1
          const poCode = `${poPrefix}${String(poSeq).padStart(3, '0')}`
          const totalAmount = full.items.reduce(
            (s, it) => s + (it.unitPrice != null ? Number(it.unitPrice) * Number(it.quantity) : 0),
            0,
          )
          const newOrder = await prisma.purchaseOrder.create({
            data: {
              projectId: existing.projectId,
              code: poCode,
              category: full.category,
              supplierId: full.supplierId,
              title: `${full.brand ?? full.title ?? '品牌'}采购订单`,
              status: 'DRAFT', // ★ V3：草稿起步，走「发起合同→确认→正式下单」标签链
              amount: totalAmount > 0 ? totalAmount : null,
              ownerId: user.userId,
              creatorId: user.userId,
              items: {
                create: full.items.map((it) => ({
                  name: it.name,
                  spec: it.spec,
                  brand: it.brand,
                  quantity: it.quantity,
                  unit: it.unit,
                  unitPrice: it.unitPrice,
                  remark: it.remark,
                })),
              },
            },
            select: { id: true },
          })
          data.orderId = newOrder.id
        } else {
          const order = await prisma.purchaseOrder.findUnique({
            where: { id: body.orderId },
            select: { id: true, projectId: true },
          })
          if (!order) throw ApiError.notFound('关联的采购订单不存在')
          if (order.projectId !== existing.projectId) {
            throw ApiError.badRequest('订单与需求不属于同一项目')
          }
          data.orderId = body.orderId
        }
        data.status = 'ORDERED'
        break
      }
      case 'cancel': {
        if (existing.status === 'ORDERED' || existing.status === 'CANCELLED') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可取消`)
        }
        data.status = 'CANCELLED'
        break
      }
    }
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.supplierRequest.update({ where: { id: existing.id }, data })
    return tx.supplierRequest.findUnique({
      where: { id: existing.id },
      include: {
        supplier: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        order: { select: { id: true, code: true, status: true } },
        items: true,
      },
    })
  })

  return ok(updated, '采购需求已更新')
})

/**
 * DELETE 删除采购需求（删除工程第 6 棒 · 采购域）
 *
 * 权限：创建人（creatorId）或 采购部/ADMIN（与 PATCH 流转同口径的采购部判定）。
 * 可见性闸：与 GET 同口径走 visibleSupplierRequestScope，不可见=不可达（404）。
 * 状态闸：DRAFT/CANCELLED 可删；QUOTED/ORDERED → 400（保留询价/订单链路历史）；
 *         PUBLISHED → 400（请先取消再删）。
 * 级联：SupplierRequestItem（事务内显式删，留审计计数）。
 * 审计：logDelete（supplierRequest.delete）。
 * 注：DRAFT/CANCELLED 状态下 orderId 必为空（cancel 在 ORDERED 被阻），无订单解链需求。
 */
export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  // 可见性闸（与 GET/列表同口径）：不可见 = 404
  const visibility = await visibleSupplierRequestScope(user.userId, user.role)
  const existing = await prisma.supplierRequest.findFirst({
    where: { id: id, ...visibility },
    select: {
      id: true,
      code: true,
      status: true,
      projectId: true,
      creatorId: true,
      orderId: true,
    },
  })
  if (!existing) throw ApiError.notFound('采购需求不存在')

  // 权限：创建人 或 采购部/ADMIN
  let isPurchaser = user.role === 'ADMIN'
  if (!isPurchaser) {
    const deptName = await getUserDeptName(user.userId)
    if (isPurchaseDept(deptName)) isPurchaser = true
  }
  if (existing.creatorId !== user.userId && !isPurchaser) {
    throw ApiError.forbidden('仅创建人或采购部可删除采购需求')
  }

  // 状态闸：只有草稿/已取消可物理删除
  if (existing.status === 'QUOTED' || existing.status === 'ORDERED') {
    throw ApiError.badRequest(
      existing.status === 'QUOTED'
        ? '已报价的采购需求不可删除（供应商已确认报价，请改用「取消」保留询价历史）'
        : '已转订单的采购需求不可删除（订单链路已建立，请改用「取消」保留历史）',
    )
  }
  if (existing.status !== 'DRAFT' && existing.status !== 'CANCELLED') {
    throw ApiError.badRequest(`当前状态 ${existing.status} 不可删除，已发布的请先取消后再删`)
  }

  // 级联删除：明细行 + 本体（同一事务）
  const deletedItems = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const items = await tx.supplierRequestItem.deleteMany({
      where: { supplierRequestId: existing.id },
    })
    await tx.supplierRequest.delete({ where: { id: existing.id } })
    return items.count
  })

  await logDelete(
    user.userId,
    'supplierRequest',
    existing.id,
    {
      code: existing.code,
      status: existing.status,
      projectId: existing.projectId,
      deletedItems,
    },
    existing.projectId,
  )

  return ok({ id: existing.id, deletedItems }, '采购需求已删除')
})
