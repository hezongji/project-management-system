/**
 * /api/purchase-requests/[id] —— 采购清单详情/流转/删除
 *
 * GET    详情（含 items + 分解出的采购需求摘要）；requester/handler/采购部/ADMIN 可见
 * PATCH  requester：改 DRAFT/REJECTED（可重新提交 SUBMITTED）
 *        handler（采购部/ADMIN）：状态流转 SUBMITTED→PROCESSING→DECOMPOSED/COMPLETED；驳回→REJECTED
 * DELETE 仅 DRAFT 且 requester 本人
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  isPurchaseDept,
  getUserDeptName,
  canViewPurchaseFinanceOf,
  visiblePurchaseRequestFilter,
  maskPurchaseFinance,
} from '@/lib/data-visibility'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const itemInputSchema = z.object({
  name: z.string().trim().min(1),
  spec: z.string().trim().optional().nullable(),
  param: z.string().trim().optional().nullable(), // ★ 2026-08-25 字段统一
  brand: z.string().trim().optional().nullable(),
  quantity: z.number().positive(),
  unit: z.string().trim().min(1).default('件'),
  remark: z.string().trim().optional().nullable(),
})

const patchSchema = z.object({
  // requester 编辑字段
  title: z.string().trim().min(1).optional(),
  purpose: z.string().trim().optional().nullable(),
  category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'URGENT']).optional(),
  expectedArrivalDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  items: z.array(itemInputSchema).min(1).optional(), // 全量替换明细
  // 流转动作
  action: z.enum(['submit', 'accept', 'decompose', 'complete', 'reject']).optional(),
  rejectReason: z.string().trim().optional(),
})

/** 加载清单 + 可见性校验（★ Step3：详情与列表同口径，统一走 scope 过滤；
 *  V3 硬性要求 C：删除「项目成员」回退，不可见=不可达） */
async function loadVisible(id: string, userId: string, role: string) {
  const visibility = await visiblePurchaseRequestFilter(userId, role)
  const req = await prisma.purchaseRequest.findFirst({
    where: { id, ...visibility },
    include: {
      requester: { select: { id: true, name: true } },
      handler: { select: { id: true, name: true } },
      project: { select: { id: true, code: true, name: true } },
      supplierRequests: {
        select: { id: true, code: true, supplierId: true, status: true, title: true },
      },
      items: true,
    },
  })
  if (!req) throw ApiError.notFound('采购清单不存在')
  return req
}

export const GET = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)
  const req = await loadVisible(id, user.userId, user.role)

  // 金额脱敏（★ V3：去 OWNER/MANAGER 默认，改 purchaseFinanceGranted 授权）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  // ★ Step3：统一走 maskPurchaseFinance（防手写清单漏字段）
  const items = req.items.map((it) =>
    maskPurchaseFinance(
      {
        ...it,
        targetPrice: it.targetPrice != null ? Number(it.targetPrice) : null,
        quantity: Number(it.quantity),
        allocatedQty: Number(it.allocatedQty),
      },
      finOk,
    ),
  )

  return ok({ ...req, items })
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchSchema.parse(raw)

  const existing = await prisma.purchaseRequest.findUnique({
    where: { id: id },
    select: {
      id: true,
      status: true,
      requesterId: true,
      handlerId: true,
      projectId: true,
    },
  })
  if (!existing) throw ApiError.notFound('采购清单不存在')

  const isRequester = existing.requesterId === user.userId
  const deptName = await getUserDeptName(user.userId)
  const isPurchaser = isPurchaseDept(deptName) || user.role === 'ADMIN'

  const data: Record<string, unknown> = {}

  if (body.action) {
    switch (body.action) {
      case 'submit': {
        // requester 把 DRAFT/REJECTED 重新提交
        if (!isRequester) throw ApiError.forbidden('仅提需求人可提交清单')
        if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可提交`)
        }
        data.status = 'SUBMITTED'
        data.rejectReason = null
        break
      }
      case 'accept': {
        // 采购受理：SUBMITTED → PROCESSING（记录 handler）
        if (!isPurchaser) throw ApiError.forbidden('仅采购部可受理清单')
        if (existing.status !== 'SUBMITTED') throw ApiError.badRequest('仅已提交状态可受理')
        data.status = 'PROCESSING'
        data.handlerId = user.userId
        break
      }
      case 'decompose': {
        // 分解完成：PROCESSING（或 SUBMITTED）→ DECOMPOSED
        if (!isPurchaser) throw ApiError.forbidden('仅采购部可操作')
        if (existing.status !== 'PROCESSING' && existing.status !== 'SUBMITTED') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可标记分解`)
        }
        data.status = 'DECOMPOSED'
        if (!existing.handlerId) data.handlerId = user.userId
        break
      }
      case 'complete': {
        if (!isPurchaser) throw ApiError.forbidden('仅采购部可操作')
        if (existing.status !== 'DECOMPOSED' && existing.status !== 'PROCESSING') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可完成`)
        }
        data.status = 'COMPLETED'
        break
      }
      case 'reject': {
        // 驳回回退给提需求人
        if (!isPurchaser) throw ApiError.forbidden('仅采购部可驳回清单')
        if (existing.status === 'REJECTED' || existing.status === 'COMPLETED' || existing.status === 'DRAFT') {
          throw ApiError.badRequest(`当前状态 ${existing.status} 不可驳回`)
        }
        if (!body.rejectReason) throw ApiError.badRequest('驳回必须填写原因')
        data.status = 'REJECTED'
        data.rejectReason = body.rejectReason
        if (!existing.handlerId) data.handlerId = user.userId
        break
      }
    }
  }

  // requester 编辑字段（仅 DRAFT/REJECTED 可改）
  const editFields: string[] = []
  if (isRequester && (existing.status === 'DRAFT' || existing.status === 'REJECTED')) {
    if (body.title !== undefined) { data.title = body.title; editFields.push('title') }
    if (body.purpose !== undefined) { data.purpose = body.purpose; editFields.push('purpose') }
    if (body.category !== undefined) { data.category = body.category; editFields.push('category') }
    if (body.priority !== undefined) { data.priority = body.priority; editFields.push('priority') }
    if (body.expectedArrivalDate !== undefined) {
      data.expectedArrivalDate = body.expectedArrivalDate ? new Date(body.expectedArrivalDate) : null
      editFields.push('expectedArrivalDate')
    }
    if (body.remark !== undefined) { data.remark = body.remark; editFields.push('remark') }
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 明细全量替换
    if (body.items && isRequester && (existing.status === 'DRAFT' || existing.status === 'REJECTED')) {
      await tx.purchaseRequestItem.deleteMany({ where: { requestId: existing.id } })
      await tx.purchaseRequestItem.createMany({
        data: body.items.map((it) => ({
          requestId: existing.id,
          name: it.name,
          spec: it.spec ?? null,
          param: it.param ?? null,
          brand: it.brand ?? null,
          quantity: it.quantity,
          unit: it.unit,
          remark: it.remark ?? null,
        })),
      })
    }
    if (Object.keys(data).length > 0) {
      await tx.purchaseRequest.update({ where: { id: existing.id }, data })
    }
    return tx.purchaseRequest.findUnique({
      where: { id: existing.id },
      include: {
        items: true,
        requester: { select: { id: true, name: true } },
        handler: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
      },
    })
  })

  return ok(updated, '采购清单已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const existing = await prisma.purchaseRequest.findUnique({
    where: { id: id },
    select: { id: true, status: true, requesterId: true },
  })
  if (!existing) throw ApiError.notFound('采购清单不存在')
  if (existing.requesterId !== user.userId && user.role !== 'ADMIN') {
    throw ApiError.forbidden('仅提需求人可删除清单')
  }
  if (existing.status !== 'DRAFT') throw ApiError.badRequest('仅草稿状态可删除')

  await prisma.purchaseRequest.delete({ where: { id: existing.id } })
  return ok({ id: existing.id }, '采购草稿已删除')
})
