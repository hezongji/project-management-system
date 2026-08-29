/**
 * GET /api/purchase-orders/consolidated?projectId=xxx —— ★ 2026-08-25 项目采购总清单（合并汇总）
 *
 * 把项目下所有「已采购」订单明细合并成一张总清单（多批次同类项数量/金额累加），
 * 按机械/电气/其他三大类分组，用于：
 *   - 项目执行中随时阶段性合并（灵活，不限结项）
 *   - 结项归档三大类总采购清单
 *   - 后续项目复用与成本核算
 *
 * 口径：
 *   - 订单范围：默认排除 DRAFT（草稿未真正采购）；?includeDraft=1 可包含
 *   - 分类：按订单 category 归入三大类（订单创建时已选类别）
 *   - 合并同类项：类内 name+spec+param+brand 相同 → quantity/金额累加、记批次与最近采购日
 *   - 金额脱敏：无采购财务权限（canViewPurchaseFinanceOf）者 unitPrice/amount/totalAmount 置 null
 *   - 可见性：visiblePurchaseOrderFilter（与订单列表同口径）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  canViewPurchaseFinanceOf,
  visiblePurchaseOrderFilter,
} from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

interface ConsolidatedItem {
  name: string
  spec: string | null
  param: string | null
  brand: string | null
  unit: string
  totalQty: number
  /** 加权平均单价（有报价的批次），无财务权限为 null */
  avgUnitPrice: number | null
  /** 累计金额（有报价批次之和），无财务权限为 null */
  totalAmount: number | null
  /** 采购批次（出现过的订单数） */
  batchCount: number
  /** 涉及订单编号（溯源，最多列 5 个） */
  orderCodes: string[]
  lastPurchasedAt: string | null
}

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const projectId = (searchParams.get('projectId') || '').trim()
  if (!projectId) throw ApiError.badRequest('缺少 projectId 参数')
  const includeDraft = searchParams.get('includeDraft') === '1'

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, code: true, name: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const scope = await visiblePurchaseOrderFilter(user.userId, user.role)
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      ...scope,
      projectId,
      ...(includeDraft ? {} : { status: { not: 'DRAFT' } }),
    },
    select: {
      code: true,
      category: true,
      createdAt: true,
      amount: true,
      items: {
        select: {
          name: true,
          spec: true,
          param: true,
          brand: true,
          quantity: true,
          unit: true,
          unitPrice: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  // ── 合并：三大类 × 同类项（name|spec|param|brand） ──
  const CATEGORY_LABEL: Record<string, string> = {
    MECHANICAL: '机械',
    ELECTRICAL: '电气',
    OTHER: '其他',
  }
  const orderKeys = ['MECHANICAL', 'ELECTRICAL', 'OTHER'] as const

  const groups = new Map<
    string,
    {
      acc: Map<
        string,
        ConsolidatedItem & { _qtyPriced: number; _amount: number; _codes: Set<string> }
      >
      orderCount: number
      rawAmount: number
    }
  >()
  for (const key of orderKeys) groups.set(key, { acc: new Map(), orderCount: 0, rawAmount: 0 })

  for (const o of orders) {
    const cat = (orderKeys as readonly string[]).includes(o.category) ? o.category : 'OTHER'
    const g = groups.get(cat)!
    g.orderCount += 1
    g.rawAmount += Number(o.amount ?? 0)
    for (const it of o.items) {
      const key = `${it.name}|${it.spec ?? ''}|${it.param ?? ''}|${it.brand ?? ''}`
      const row =
        g.acc.get(key) ??
        {
          name: it.name,
          spec: it.spec,
          param: it.param,
          brand: it.brand,
          unit: it.unit,
          totalQty: 0,
          avgUnitPrice: null,
          totalAmount: null,
          batchCount: 0,
          orderCodes: [],
          lastPurchasedAt: null,
          _qtyPriced: 0,
          _amount: 0,
          _codes: new Set<string>(),
        }
      row.totalQty += Number(it.quantity)
      row.batchCount += 1
      row._codes.add(o.code)
      const price = it.unitPrice != null ? Number(it.unitPrice) : null
      if (price != null) {
        row._qtyPriced += Number(it.quantity)
        row._amount += Number(it.quantity) * price
      }
      const created = o.createdAt.toISOString()
      if (!row.lastPurchasedAt || created > row.lastPurchasedAt) row.lastPurchasedAt = created
      g.acc.set(key, row)
    }
  }

  const categories = orderKeys
    .map((cat) => {
      const g = groups.get(cat)!
      const items = Array.from(g.acc.values())
        .map((r) => ({
          name: r.name,
          spec: r.spec,
          param: r.param,
          brand: r.brand,
          unit: r.unit,
          totalQty: r.totalQty,
          avgUnitPrice: finOk
            ? r._qtyPriced > 0
              ? Math.round((r._amount / r._qtyPriced) * 100) / 100
              : null
            : null,
          totalAmount: finOk ? Math.round(r._amount * 100) / 100 : null,
          batchCount: r.batchCount,
          orderCodes: Array.from(r._codes).slice(0, 5),
          lastPurchasedAt: r.lastPurchasedAt,
        }))
        .sort((a, b) => b.totalQty - a.totalQty || a.name.localeCompare(b.name))
      return {
        category: cat,
        label: CATEGORY_LABEL[cat]!,
        orderCount: g.orderCount,
        itemCount: items.length,
        totalQty: Math.round(items.reduce((s, i) => s + i.totalQty, 0) * 100) / 100,
        totalAmount: finOk
          ? Math.round(items.reduce((s, i) => s + (i.totalAmount ?? 0), 0) * 100) / 100
          : null,
        items,
      }
    })
    .filter((c) => c.itemCount > 0 || c.orderCount > 0)

  const totalAmount = finOk ? categories.reduce((s, c) => s + (c.totalAmount ?? 0), 0) : null

  return ok({
    project: { id: project.id, code: project.code, name: project.name },
    includeDraft,
    orderCount: orders.length,
    categories,
    summary: {
      totalAmount: finOk && totalAmount != null ? Math.round(totalAmount * 100) / 100 : null,
      totalItems: categories.reduce((s, c) => s + c.itemCount, 0),
      generatedAt: new Date().toISOString(),
    },
  })
})
