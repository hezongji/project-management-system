import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept } from '@/lib/data-visibility'
import { nextPurchaseOrderCode } from '@/lib/purchase-codes'
import { orderNotifyTargets } from '@/lib/purchase-workflow'
import type { Prisma, PurchaseCategory } from '@prisma/client'
import { z } from 'zod'

/**
 * /api/purchase-orders/generate —— ★ 2026-08-25 按供应商归单引擎（采购模块重构核心）
 *
 * POST { supplierRequestIds: string[], plannedArrivalDate?, remark? }
 *
 * 规则（用户需求原文）：
 *   指定完供应商后再根据供应商把材料归纳到一起，一键生成采购订单，一个供应商一个外发订单。
 *
 * 事务内：
 *   1. 校验：采购部/ADMIN；任务同项目、未转单、状态 PUBLISHED/QUOTED
 *   2. 按供应商分组：同一 supplierId 的所有品牌任务 → 合并生成 1 张 DRAFT 订单（CG-*）
 *      订单明细 = 各任务明细顺序展开（保留品牌列，可溯源）
 *   3. 任务回写 orderId + status=ORDERED
 *   4. 通知：发布人 ∪ 项目全体成员 ∪ ADMIN
 * 未指定供应商的任务 → 400 拒绝并提示先指定
 */

export const dynamic = 'force-dynamic'

const generateSchema = z.object({
  supplierRequestIds: z.array(z.string().min(1)).min(1, '请选择至少一个采购任务'),
  plannedArrivalDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = generateSchema.parse(raw)

  // 权限：采购部 / ADMIN
  const deptName = await getUserDeptName(user.userId)
  const isPurchaser = isPurchaseDept(deptName) || user.role === 'ADMIN'
  if (!isPurchaser) throw ApiError.forbidden('仅采购部可生成采购订单')

  const srs = await prisma.supplierRequest.findMany({
    where: { id: { in: body.supplierRequestIds } },
    include: {
      items: { orderBy: { name: 'asc' } },
      supplier: { select: { id: true, name: true } },
      project: { select: { id: true, code: true, name: true, isArchived: true } },
      request: { select: { code: true, requesterId: true } },
    },
    orderBy: { code: 'asc' },
  })
  if (srs.length !== body.supplierRequestIds.length) {
    throw ApiError.notFound('部分采购任务不存在（可能已被删除），请刷新后重试')
  }

  // 校验：同项目 / 未转单 / 状态合法 / 项目未归档
  const projectIds = new Set(srs.map((s) => s.projectId))
  if (projectIds.size > 1) throw ApiError.badRequest('所选任务必须属于同一项目')
  const projectId = srs[0]!.projectId
  if (srs[0]!.project.isArchived) throw new ApiError(403, '项目已归档，无法生成采购订单')
  const alreadyOrdered = srs.filter((s) => s.orderId)
  if (alreadyOrdered.length > 0) {
    throw ApiError.badRequest(`任务 ${alreadyOrdered.map((s) => s.code).join('、')} 已转订单，不可重复生成`)
  }
  const badStatus = srs.filter((s) => s.status !== 'PUBLISHED' && s.status !== 'QUOTED')
  if (badStatus.length > 0) {
    throw ApiError.badRequest(
      `任务 ${badStatus.map((s) => s.code).join('、')} 状态不允许生成订单（需为已发布/已报价）`,
    )
  }
  const noSupplier = srs.filter((s) => !s.supplierId)
  if (noSupplier.length > 0) {
    throw ApiError.badRequest(
      `任务 ${noSupplier.map((s) => s.code).join('、')} 尚未指定供应商，请先在任务详情中指定供应商`,
    )
  }

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const orders: Array<{
        id: string
        code: string
        supplierName: string
        itemCount: number
        brands: string[]
        amount: number | null
        srCodes: string[]
      }> = []

      // ★ 按供应商分组归单（一个供应商一张外发订单）
      const bySupplier = new Map<string, typeof srs>()
      for (const sr of srs) {
        const key = sr.supplierId!
        const arr = bySupplier.get(key) ?? []
        arr.push(sr)
        bySupplier.set(key, arr)
      }

      for (const [supplierId, group] of Array.from(bySupplier.entries())) {
        const code = await nextPurchaseOrderCode(tx, srs[0]!.project.code)
        const allItems = group.flatMap((g) => g.items)
        const amount = allItems.reduce(
          (s, it) => s + (it.unitPrice != null ? Number(it.unitPrice) * Number(it.quantity) : 0),
          0,
        )
        const brands = Array.from(new Set(group.map((g) => g.brand).filter((b): b is string => !!b)))
        // 订单类别取组内多数
        const catCounts = new Map<string, number>()
        group.forEach((g) => catCounts.set(g.category, (catCounts.get(g.category) ?? 0) + 1))
        const category = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1])[0]![0] as PurchaseCategory

        const order = await tx.purchaseOrder.create({
          data: {
            projectId,
            code,
            title:
              brands.length > 0
                ? `${group[0]!.supplier?.name ?? ''}采购订单（${brands.join('、')}）`.slice(0, 120)
                : `${group[0]!.supplier?.name ?? '供应商'}采购订单`,
            category,
            supplierId,
            status: 'DRAFT',
            plannedArrivalDate: body.plannedArrivalDate ? new Date(body.plannedArrivalDate) : null,
            amount: amount > 0 ? amount : null,
            ownerId: user.userId,
            creatorId: user.userId,
            remark:
              body.remark ??
              `按供应商归单生成（来源任务：${group.map((g) => g.code).join('、')}）`,
            items: {
              create: allItems.map((it) => ({
                name: it.name,
                // ★ 2026-08-25 字段统一：param 分列存，不再拼入 spec
                spec: it.spec ?? null,
                param: it.param ?? null,
                brand: it.brand,
                quantity: it.quantity,
                unit: it.unit,
                unitPrice: it.unitPrice,
                remark: it.remark,
              })),
            },
          },
          select: { id: true, code: true },
        })

        // 任务回写：orderId + ORDERED
        for (const g of group) {
          await tx.supplierRequest.update({
            where: { id: g.id },
            data: { orderId: order.id, status: 'ORDERED' },
          })
        }

        orders.push({
          id: order.id,
          code: order.code,
          supplierName: group[0]!.supplier?.name ?? '',
          itemCount: allItems.length,
          brands,
          amount: amount > 0 ? amount : null,
          srCodes: group.map((g) => g.code),
        })
      }

      // ★ 通知：发布人（所选任务溯源）∪ 项目全体成员 ∪ ADMIN（订单已生成，进入合同流程）
      const targets = await orderNotifyTargets(tx, '', projectId)
      srs.forEach((s) => {
        if (s.request?.requesterId) targets.add(s.request.requesterId)
      })
      targets.delete(user.userId)
      const project = srs[0]!.project
      for (const uid of Array.from(targets)) {
        const title = `采购订单已生成：${orders.map((o) => o.code).join('、')}`
        const body = `「${project.name}」已按供应商归单生成 ${orders.length} 张采购订单，进入合同流程`
        await tx.notification.create({
          data: { userId: uid, type: 'PURCHASE_STATUS_CHANGED', title, body, link: `/purchase?orderId=${orders[0]?.id ?? ''}` },
        })
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'notify:push',
          userId: uid,
          title,
          body,
          link: `/purchase?orderId=${orders[0]?.id ?? ''}`,
        })})`
      }

      return { orders, requestCodes: Array.from(new Set(srs.map((s) => s.request?.code).filter(Boolean))) }
    },
    { timeout: 30_000 },
  )

  return created(
    result,
    `已按 ${result.orders.length} 个供应商生成 ${result.orders.length} 张采购订单（草稿，请推进合同流程）`,
  )
})
