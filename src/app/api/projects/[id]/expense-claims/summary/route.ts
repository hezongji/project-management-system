/**
 * /api/projects/[id]/expense-claims/summary —— 项目报销单统计（F2-R2）
 *
 * GET 报销汇总：总额/按状态（报销单维度）/按分类（明细维度）
 *   ★ 只统计当前用户可见的报销单（报销人本人 + 财务部 + ADMIN；
 *     其他人——含项目 OWNER/MANAGER/成员——只得到 0）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { visibleExpenseClaimScope } from '@/lib/data-visibility'
import type { Prisma } from '@prisma/client'
import { ExpenseStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const ALL_STATUSES: ExpenseStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID']

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true, code: true, name: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  // ★ 可见性口径与列表一致：只统计可见报销单
  const visibility = await visibleExpenseClaimScope(user.userId, user.role)
  const where: Prisma.ExpenseClaimWhereInput = { projectId: id, ...visibility }

  const [totalCount, byStatusGroups, byCategoryGroups, totalAgg] = await Promise.all([
    prisma.expenseClaim.count({ where }),
    // 状态统计：报销单维度（单据数 + 单据金额）
    prisma.expenseClaim.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    // 分类汇总：明细维度（经 claim 应用可见性过滤）
    prisma.expenseItem.groupBy({
      by: ['categoryId'],
      where: { claim: where },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    // ★ P2-2：总额用 DB Decimal 聚合直接得出，避免 JS Number 浮点累加尾差
    prisma.expenseClaim.aggregate({ where, _sum: { totalAmount: true } }),
  ])

  // 分类名称补齐（groupBy 只有 categoryId）
  const categoryIds = byCategoryGroups.map((g) => g.categoryId)
  const categories = categoryIds.length
    ? await prisma.expenseCategory.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true, code: true },
      })
    : []
  const catMap = new Map(categories.map((c) => [c.id, c]))

  const statusMap = new Map(byStatusGroups.map((g) => [g.status, g]))
  const byStatus = ALL_STATUSES.map((s) => {
    const g = statusMap.get(s)
    return {
      status: s,
      count: g?._count._all ?? 0,
      amount: Number(g?._sum.totalAmount ?? 0),
    }
  })

  // ★ P2-2：总额取自 aggregate 的 Decimal _sum（Number 单次转换，无浮点累加）
  const totalAmount = Number(totalAgg._sum.totalAmount ?? 0)

  return ok({
    project: { id: project.id, code: project.code, name: project.name },
    total: { count: totalCount, amount: totalAmount },
    byStatus,
    byCategory: byCategoryGroups
      .map((g) => ({
        categoryId: g.categoryId,
        categoryName: catMap.get(g.categoryId)?.name ?? '未知分类',
        count: g._count._all,
        amount: Number(g._sum.amount ?? 0),
      }))
      .sort((a, b) => b.amount - a.amount),
  })
})
