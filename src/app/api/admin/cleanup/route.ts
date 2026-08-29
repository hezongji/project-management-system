/**
 * /api/admin/cleanup —— 依据《docs/设计方案-删除与垃圾清理.md》§5 垃圾数据批量清理
 *
 * POST  ADMIN  body { type: string }，按 type 在事务内批量 deleteMany 一类垃圾数据
 *
 * 五类判定条件与 /api/admin/cleanup-stats 完全同口径（两文件同步维护，勿单边修改）；
 * 引用保护收紧项与单删语义对齐：
 *   - draftPurchaseOrders：跳过有付款/追加单/已确认到货的草稿单；删除时先解链
 *     SupplierRequest（orderId=null + 状态回退 ORDERED→QUOTED/PUBLISHED），
 *     并级联删除未确认到货/订单明细/草稿期合同（同 /purchase-orders/[id] DELETE）
 *   - emptyProjects：仅删「无阶段、无成员、创建>30 天、且无任何业务数据」的项目
 *   - emptyPhases：仅删「无任务、无 FileRequirement.phaseCode 弱引用」的阶段
 *   - unusedExternalOrgs：仅删无任何业务关联的外部主体（联系人随 FK 级联）
 *   - orphanFiles：删 requirementId 为空的文件记录（访问日志随 FK 级联；
 *     磁盘物理文件不在本接口范围，见运维手册）
 *
 * 幂等：全部基于当前 DB 状态判定，重复执行第二次 deleted=0。
 * 审计：每类清理成功后写 logDelete（action=`cleanup:<type>.delete`，operatorId=当前用户）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { logDelete } from '@/lib/delete-helpers'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

const CLEANUP_TYPES = [
  'draftPurchaseOrders',
  'emptyProjects',
  'emptyPhases',
  'unusedExternalOrgs',
  'orphanFiles',
] as const
type CleanupType = (typeof CLEANUP_TYPES)[number]

// ─────────────── 判定条件（与 cleanup-stats/route.ts 同步维护） ───────────────

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
  }
}

const draftPurchaseOrderWhere = {
  status: 'DRAFT' as const,
  payments: { none: {} },
  supplementaryItems: { none: {} },
  arrivals: { none: { status: { not: 'PENDING' as const } } },
}

const unusedExternalOrgWhere = {
  projects: { none: {} },
  purchaseOrders: { none: {} },
  supplierRequests: { none: {} },
  goodsArrivals: { none: {} },
}

// ─────────────── 各类清理实现（返回删除条数） ───────────────

/**
 * 草稿采购订单：解链 SupplierRequest → 未确认到货 → 明细 → 草稿合同 → 本体。
 * 级联顺序与 /purchase-orders/[id] DELETE 完全同构（批量版）。
 */
async function cleanupDraftPurchaseOrders(tx: Prisma.TransactionClient): Promise<number> {
  const orders = await tx.purchaseOrder.findMany({
    where: draftPurchaseOrderWhere,
    select: { id: true },
  })
  if (orders.length === 0) return 0
  const ids = orders.map((o) => o.id)

  // 1) SupplierRequest 解链 + 状态回退（ORDERED→QUOTED 有报价 / PUBLISHED 无报价，可重转单）
  await tx.supplierRequest.updateMany({
    where: { orderId: { in: ids }, status: 'ORDERED', quotedAt: { not: null } },
    data: { orderId: null, status: 'QUOTED' },
  })
  await tx.supplierRequest.updateMany({
    where: { orderId: { in: ids }, status: 'ORDERED', quotedAt: null },
    data: { orderId: null, status: 'PUBLISHED' },
  })
  // 兜底解链（ orderId 指向草稿单但状态非 ORDERED 的历史脏数据 ）
  await tx.supplierRequest.updateMany({
    where: { orderId: { in: ids } },
    data: { orderId: null },
  })

  // 2) 未确认到货（PENDING 在途登记）→ 删除（GoodsArrivalItem 随 FK 级联）
  await tx.goodsArrival.deleteMany({ where: { orderId: { in: ids }, status: 'PENDING' } })

  // 3) 订单明细 → 删除（此时已无到货明细引用）
  await tx.purchaseOrderItem.deleteMany({ where: { orderId: { in: ids } } })

  // 4) 草稿期登记的合同（1:1）→ 删除
  await tx.purchaseContract.deleteMany({ where: { orderId: { in: ids } } })

  // 5) 本体
  const result = await tx.purchaseOrder.deleteMany({ where: { id: { in: ids } } })
  return result.count
}

/** 空项目：判定即 where，直接批量删（关联表均已 none，无级联负担；ActivityLog.projectId 随 SetNull 解链） */
async function cleanupEmptyProjects(tx: Prisma.TransactionClient): Promise<number> {
  const result = await tx.project.deleteMany({ where: emptyProjectWhere() })
  return result.count
}

/**
 * 空阶段：先找「无任务」候选，剔除被 FileRequirement.phaseCode（同项目）弱引用的，再按 id 批量删。
 * （FileRequirement→Phase 无 FK，仅字符串弱关联，relation filter 无法表达，须两步查询）
 */
async function cleanupEmptyPhases(tx: Prisma.TransactionClient): Promise<number> {
  const [candidates, usedPairs] = await Promise.all([
    tx.phase.findMany({
      where: { tasks: { none: {} } },
      select: { id: true, projectId: true, code: true },
    }),
    tx.fileRequirement.findMany({
      where: { phaseCode: { not: null } },
      select: { projectId: true, phaseCode: true },
      distinct: ['projectId', 'phaseCode'],
    }),
  ])
  const used = new Set(usedPairs.map((r) => `${r.projectId}:${r.phaseCode}`))
  const ids = candidates
    .filter((p) => !used.has(`${p.projectId}:${p.code}`))
    .map((p) => p.id)
  if (ids.length === 0) return 0
  const result = await tx.phase.deleteMany({ where: { id: { in: ids } } })
  return result.count
}

/** 未使用外部主体：判定即 where（ExternalContact 随 orgId FK 级联删除） */
async function cleanupUnusedExternalOrgs(tx: Prisma.TransactionClient): Promise<number> {
  const result = await tx.externalOrg.deleteMany({ where: unusedExternalOrgWhere })
  return result.count
}

/** 孤儿文件记录：requirementId 为空（FileAccessLog 随 fileId FK 级联；磁盘文件另行运维清理） */
async function cleanupOrphanFiles(tx: Prisma.TransactionClient): Promise<number> {
  const result = await tx.file.deleteMany({ where: { requirementId: null } })
  return result.count
}

// ─────────────── Handler ───────────────

export const POST = apiHandler(async (request: NextRequest) => {
  const user = await requireAdmin(request)

  const body = (await request.json().catch(() => ({}))) as { type?: unknown }
  const type = typeof body.type === 'string' ? body.type : ''
  if (!CLEANUP_TYPES.includes(type as CleanupType)) {
    throw ApiError.badRequest(
      `无效的清理类型「${type || '(空)'}」；可选：${CLEANUP_TYPES.join(' / ')}`
    )
  }

  const deleted = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    switch (type as CleanupType) {
      case 'draftPurchaseOrders':
        return cleanupDraftPurchaseOrders(tx)
      case 'emptyProjects':
        return cleanupEmptyProjects(tx)
      case 'emptyPhases':
        return cleanupEmptyPhases(tx)
      case 'unusedExternalOrgs':
        return cleanupUnusedExternalOrgs(tx)
      case 'orphanFiles':
        return cleanupOrphanFiles(tx)
    }
  })

  await logDelete(user.userId, `cleanup:${type}`, 'batch', {
    type,
    deleted,
    cleanedAt: new Date().toISOString(),
  })

  return ok({ type, deleted }, `已清理 ${deleted} 条「${type}」`)
})
