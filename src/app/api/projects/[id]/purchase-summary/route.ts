/**
 * /api/projects/[id]/purchase-summary —— 项目采购成本汇总
 *
 * GET 项目采购总览（设计方案 §成本汇总）：
 *   订单数/总金额/实际结算总额 + 按类别/按供应商分组 + 清单数/待处理数
 *   金额字段用 canViewPurchaseFinance 判定（ADMIN/财务部/采购部/项目OWNER/MANAGER），
 *   无权限 → 所有 amount 为 null（脱敏，数量类统计仍可见）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  visibleProjectFilter,
  getUserDeptName,
  canViewPurchaseFinanceOf,
} from '@/lib/data-visibility'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  // 项目可见性（成员制）+ 存在性
  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true, code: true, name: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (user.role !== 'ADMIN') {
    const visibility = await visibleProjectFilter(user.userId, user.role)
    // 空对象 = ADMIN/全量；否则要求命中成员过滤
    const hit = await prisma.project.findFirst({
      where: { AND: [{ id: id }, visibility] },
      select: { id: true },
    })
    if (!hit) throw ApiError.forbidden('无权查看该项目')
  }

  // 财务权限判定（★ V3：去 OWNER/MANAGER 默认，改 purchaseFinanceGranted 授权）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  const orderWhere: Prisma.PurchaseOrderWhereInput = { projectId: id }
  const requestWhere: Prisma.PurchaseRequestWhereInput = { projectId: id }

  const [
    orderCount,
    orderStatusGroups,
    byCategory,
    bySupplier,
    requestCount,
    requestStatusGroups,
  ] = await Promise.all([
    prisma.purchaseOrder.count({ where: orderWhere }),
    prisma.purchaseOrder.groupBy({
      by: ['status'],
      where: orderWhere,
      _count: { _all: true },
      _sum: { amount: true, settlementAmount: true },
    }),
    prisma.purchaseOrder.groupBy({
      by: ['category'],
      where: orderWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.purchaseOrder.groupBy({
      by: ['supplierId'],
      where: { ...orderWhere, supplierId: { not: null } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.purchaseRequest.count({ where: requestWhere }),
    prisma.purchaseRequest.groupBy({
      by: ['status'],
      where: requestWhere,
      _count: { _all: true },
    }),
  ])

  // 供应商名称补齐（groupBy 只有 supplierId）
  const supplierIds = bySupplier.map((g) => g.supplierId).filter((x): x is string => !!x)
  const suppliers = supplierIds.length
    ? await prisma.externalOrg.findMany({
        where: { id: { in: supplierIds } },
        select: { id: true, name: true },
      })
    : []
  const supplierNameMap = new Map(suppliers.map((s) => [s.id, s.name]))

  const totalAmount =
    orderStatusGroups.reduce((acc, g) => acc + Number(g._sum.amount ?? 0), 0) || null
  const settledAmount =
    orderStatusGroups.reduce((acc, g) => acc + Number(g._sum.settlementAmount ?? 0), 0) || null

  return ok({
    project: { id: project.id, code: project.code, name: project.name },
    financeVisible: finOk,
    orders: {
      count: orderCount,
      byStatus: Object.fromEntries(
        orderStatusGroups.map((g) => [g.status, g._count._all]),
      ),
      totalAmount: finOk ? totalAmount : null,
      settledAmount: finOk ? settledAmount : null,
      inTransit:
        (orderStatusGroups.find((g) => g.status === 'ORDERED')?._count._all ?? 0) +
        (orderStatusGroups.find((g) => g.status === 'PARTIAL')?._count._all ?? 0),
    },
    byCategory: byCategory.map((g) => ({
      category: g.category,
      count: g._count._all,
      amount: finOk ? Number(g._sum.amount ?? 0) : null,
    })),
    bySupplier: bySupplier.map((g) => ({
      supplierId: g.supplierId,
      supplierName: supplierNameMap.get(g.supplierId ?? '') ?? null,
      count: g._count._all,
      amount: finOk ? Number(g._sum.amount ?? 0) : null,
    })),
    requests: {
      count: requestCount,
      pending:
        (requestStatusGroups.find((g) => g.status === 'SUBMITTED')?._count._all ?? 0) +
        (requestStatusGroups.find((g) => g.status === 'PROCESSING')?._count._all ?? 0),
      byStatus: Object.fromEntries(
        requestStatusGroups.map((g) => [g.status, g._count._all]),
      ),
    },
  })
})
