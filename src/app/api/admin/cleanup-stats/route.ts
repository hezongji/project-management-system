/**
 * /api/admin/cleanup-stats —— 依据《docs/设计方案-删除与垃圾清理.md》§4 垃圾数据统计
 *
 * GET  ADMIN  统计各类「可清理垃圾」数量（只读 count，不执行任何删除）
 *
 * 五类口径（与 /api/admin/cleanup 保持同口径，含引用保护收紧项，两文件同步维护）：
 *   1. draftPurchaseOrders：PurchaseOrder status=DRAFT 且无付款流水 / 无追加单引用 / 无已确认到货
 *      （收紧自第 6 棒单删语义：这些引用存在时单删会 400 拒绝，批量清理同样跳过）
 *   2. emptyProjects：Project 无任何 Phase 且无 ProjectMember 且 createdAt>30 天，
 *      且无任务/文件/文件条目/目录/会话/采购链数据（防止误删仅无阶段但有业务数据的项目）
 *   3. emptyPhases：Phase 无 Task，且同项目下无 phaseCode 指向它的 FileRequirement
 *      （FileRequirement 通过 phaseCode 字符串弱关联 Phase，无 FK）
 *   4. unusedExternalOrgs：ExternalOrg 无 Project(customerId) / PurchaseOrder / SupplierRequest /
 *      GoodsArrival 关联（联系人随 FK 级联）
 *   5. orphanFiles：File requirementId 为空（计划外临时文件 + 条目删除后被 SetNull 的孤儿）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

// ─────────────── 判定条件（与 cleanup/route.ts 同步维护，勿单边修改） ───────────────

/** 空项目年龄阈值：创建超过 30 天才纳入清理 */
const EMPTY_PROJECT_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000

function emptyProjectWhere() {
  const cutoff = new Date(Date.now() - EMPTY_PROJECT_MIN_AGE_MS)
  return {
    createdAt: { lt: cutoff },
    phases: { none: {} },
    members: { none: {} },
    tasks: { none: {} },
    requirements: { none: {} },
    files: { none: {} },
    catalogs: { none: {} },
    conversations: { none: {} },
    purchaseRequests: { none: {} },
    supplierRequests: { none: {} },
    purchaseOrders: { none: {} },
    goodsArrivals: { none: {} },
  } satisfies Prisma.ProjectWhereInput
}

const draftPurchaseOrderWhere = {
  status: 'DRAFT' as const,
  // 引用保护（对齐单删 /purchase-orders/[id] DELETE）：付款/追加单/已确认到货存在 → 不可清理
  payments: { none: {} },
  supplementaryItems: { none: {} },
  arrivals: { none: { status: { not: 'PENDING' as const } } },
} satisfies Prisma.PurchaseOrderWhereInput

const unusedExternalOrgWhere = {
  projects: { none: {} },
  purchaseOrders: { none: {} },
  supplierRequests: { none: {} },
  goodsArrivals: { none: {} },
} satisfies Prisma.ExternalOrgWhereInput

const orphanFileWhere = {
  requirementId: null,
} satisfies Prisma.FileWhereInput

/** 空阶段统计：候选（无任务）剔除被 FileRequirement.phaseCode 弱引用的（与清理同算法） */
async function countEmptyPhases(): Promise<number> {
  const [candidates, usedPairs] = await Promise.all([
    prisma.phase.findMany({
      where: { tasks: { none: {} } },
      select: { projectId: true, code: true },
    }),
    prisma.fileRequirement.findMany({
      where: { phaseCode: { not: null } },
      select: { projectId: true, phaseCode: true },
      distinct: ['projectId', 'phaseCode'],
    }),
  ])
  const used = new Set(usedPairs.map((r) => `${r.projectId}:${r.phaseCode}`))
  return candidates.filter((p) => !used.has(`${p.projectId}:${p.code}`)).length
}

// ─────────────── Handler ───────────────

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const [draftPurchaseOrders, emptyProjects, emptyPhases, unusedExternalOrgs, orphanFiles] =
    await Promise.all([
      prisma.purchaseOrder.count({ where: draftPurchaseOrderWhere }),
      prisma.project.count({ where: emptyProjectWhere() }),
      countEmptyPhases(),
      prisma.externalOrg.count({ where: unusedExternalOrgWhere }),
      prisma.file.count({ where: orphanFileWhere }),
    ])

  return ok({
    draftPurchaseOrders,
    emptyProjects,
    emptyPhases,
    unusedExternalOrgs,
    orphanFiles,
  })
})
