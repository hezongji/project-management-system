/**
 * 数据可见性工具（权限 V2 —— 2026-08-21 公司机密保护）
 *
 * 双轴模型：「角色管操作权限（permission.ts），可见性管数据范围（本文件）」
 *
 * 决策（用户确认）：
 *   1. 项目列表 → 仅项目成员可见（非成员完全看不到，ADMIN 全量）
 *   2. 客户档案（CUSTOMER 等）→ 仅项目成员可见（用户成员项目所关联的外部主体）
 *   3. 供应商名单（SUPPLIER）→ 仅采购部可见
 *   4. 财务数据（amount/contractNo）→ 仅 ADMIN / 财务部 / 项目 OWNER / MANAGER；
 *      其余人 API 层脱敏（amount: null, contractNo: null），前端无敏感数据
 *
 * 安全兜底：列表过滤 + 详情 requireCan 双层；脱敏在 API 序列化层；
 * 不可见 = 不可达（无权限者即使猜 URL 也拿不到数据）。
 */

import { prisma } from './prisma'
import { ExternalOrgType } from '@prisma/client'
import type { Prisma } from '@prisma/client'

/** 采购部部门名（seed 数据源 company-employees.json 中的实际部门名） */
export const PURCHASE_DEPT_NAME = '采购部'
/** 财务部关键词（部门名含「财务」即视为财务部） */
const FINANCE_DEPT_KEYWORD = '财务'

/**
 * 用户可见项目过滤（列表/统计用）：
 *   ADMIN → 全量；其他 → 仅自己作为成员的项目
 */
export async function visibleProjectFilter(
  userId: string,
  role: string,
): Promise<Prisma.ProjectWhereInput> {
  if (!userId || role === 'ADMIN') return {}
  return { members: { some: { userId } } }
}

/**
 * 任务可见过滤（2026-08-21 修复 P0-1/P0-2）：非 ADMIN 仅见所属项目任务
 * （projectId ∈ 我的成员项目），与项目列表「仅成员可见」口径一致。
 */
export async function visibleTaskFilter(
  userId: string,
  role: string,
): Promise<Prisma.TaskWhereInput> {
  if (!userId || role === 'ADMIN') return {}
  return { project: { members: { some: { userId } } } }
}

/**
 * 用户可见外部主体（按类型细分，2026-08-21 权限 V2.1）
 *
 * 每种类型（CUSTOMER/SUPPLIER/OUTSOURCER/CONTRACTOR/OTHER）由管理员在
 * 「系统管理 → 权限分配 → 外部主体可见性」单独配置可见范围（ExternalOrgScope 表）：
 *   - visibility=PUBLIC    → 全员可见该类型
 *   - visibility=RESTRICTED → deptIds（部门）∪ userIds（用户）命中者可见
 *   - 无配置行 → 回退旧规则：SUPPLIER→采购部；其余→成员项目关联
 *
 * 附加规则：CUSTOMER 客户始终对「其成员项目关联的客户」可见（2026-08-21 决策保留）。
 * ADMIN 全量。
 */
export async function visibleExternalOrgFilter(
  userId: string,
  role: string,
): Promise<Prisma.ExternalOrgWhereInput> {
  if (!userId || role === 'ADMIN') return {}

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { departmentId: true, department: { select: { name: true } } },
  })
  const deptId = user?.departmentId ?? null
  const isPurchase = user?.department?.name === PURCHASE_DEPT_NAME

  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  })
  const memberProjectIds = memberships.map((m) => m.projectId)

  // 读取类型可见性配置（无配置行 = 未设置 → 回退旧规则）
  const scopes = await prisma.externalOrgScope.findMany()
  const configured = new Map(scopes.map((s) => [s.type, s]))

  const or: Prisma.ExternalOrgWhereInput[] = []

  for (const t of Object.values(ExternalOrgType)) {
    const scope = configured.get(t)
    if (scope) {
      // 已配置：PUBLIC 全员；RESTRICTED 部门/用户命中
      const hit =
        scope.visibility === 'PUBLIC' ||
        (deptId !== null && scope.deptIds.includes(deptId)) ||
        scope.userIds.includes(userId)
      if (hit) or.push({ type: t })
    } else {
      // 未配置回退旧规则：SUPPLIER→采购部；其余→成员项目关联
      if (t === 'SUPPLIER') {
        if (isPurchase) or.push({ type: 'SUPPLIER' })
      } else if (memberProjectIds.length > 0) {
        or.push({ type: t, projects: { some: { id: { in: memberProjectIds } } } })
      }
    }
  }

  // 附加：CUSTOMER 成员项目关联始终可见（项目成员看自己项目的客户）
  if (memberProjectIds.length > 0) {
    or.push({ type: 'CUSTOMER', projects: { some: { id: { in: memberProjectIds } } } })
  }

  if (or.length === 0) return { id: { in: [] } }
  return { OR: or }
}

/**
 * 财务数据可见判定：
 *   ADMIN / 财务部 / 项目 OWNER / MANAGER → true；其余 false
 * @param memberRole 用户在项目内的角色（非成员为 null）
 */
export function canViewFinance(
  role: string,
  deptName: string | null | undefined,
  memberRole: string | null | undefined,
): boolean {
  if (role === 'ADMIN') return true
  if (deptName && deptName.includes(FINANCE_DEPT_KEYWORD)) return true
  if (memberRole === 'OWNER' || memberRole === 'MANAGER') return true
  return false
}

/** 财务脱敏：无权限时把 amount/contractNo 置 null（前端自然不渲染） */
export function maskFinance<T extends { amount?: unknown; contractNo?: unknown }>(
  data: T,
  canView: boolean,
): T {
  if (canView) return data
  return { ...data, amount: null, contractNo: null }
}

// ═══════════════ 采购模块可见性/权限（★ V3 重构 2026-08-22，见设计方案-采购管理-v3 §四）═══════════════

/** 采购部关键词（部门名含「采购」即视为采购部） */
const PURCHASE_DEPT_KEYWORD = '采购'

/** 查用户部门名（无部门返回 null） */
export async function getUserDeptName(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { department: { select: { name: true } } },
  })
  return user?.department?.name ?? null
}

/** 是否采购部（按部门名包含判断） */
export function isPurchaseDept(deptName: string | null | undefined): boolean {
  return !!deptName && deptName.includes(PURCHASE_DEPT_KEYWORD)
}

/** 查用户采购金额授权标记（V3：User.purchaseFinanceGranted，管理员勾选） */
export async function getUserPurchaseFinanceGranted(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { purchaseFinanceGranted: true },
  })
  return user?.purchaseFinanceGranted ?? false
}

/**
 * ★ V3 采购金额可见判定（硬性要求 D）：
 *   ADMIN / 财务部 / 采购部 / purchaseFinanceGranted=true（管理员勾选授权）
 *   移除 OWNER/MANAGER 默认可见（v2 偏离纠正，不自动继承，需管理员逐人勾选）
 */
export function canViewPurchaseFinance(
  role: string,
  deptName: string | null | undefined,
  purchaseFinanceGranted: boolean,
): boolean {
  if (role === 'ADMIN') return true
  if (deptName && (deptName.includes(FINANCE_DEPT_KEYWORD) || deptName.includes(PURCHASE_DEPT_KEYWORD))) return true
  if (purchaseFinanceGranted) return true
  return false
}

/** 便捷版：一步查出用户采购金额可见（列表/详情 API 用） */
export async function canViewPurchaseFinanceOf(
  userId: string,
  role: string,
): Promise<boolean> {
  const [deptName, granted] = await Promise.all([
    getUserDeptName(userId),
    getUserPurchaseFinanceGranted(userId),
  ])
  return canViewPurchaseFinance(role, deptName, granted)
}

/** ★ V3 采购金额脱敏（API 序列化层）：无权限 → 金额类字段置 null */
export function maskPurchaseFinance<T extends Record<string, unknown>>(
  obj: T,
  finOk: boolean,
): T {
  if (finOk) return obj
  const FIN_FIELDS = [
    'amount', 'settlementAmount', 'paidAmount', 'unitPrice', 'targetPrice',
    'quoteAmount', 'contractAmount', 'paymentTerms',
  ]
  const out: Record<string, unknown> = { ...obj }
  for (const f of FIN_FIELDS) {
    if (f in out) out[f] = null
  }
  return out as T
}

/**
 * ★ V3 采购单据统一可见过滤（硬性要求 C）：
 *   ADMIN → 全量；采购部 → 全量（跨项目）；
 *   其余 → 仅自己发布的（requester/creator/owner）∪ 被单独授权（PurchaseScopeGrant）∪ 被指派收货人（订单/到货）
 *   ★ 删除「我成员项目」分支：项目成员（非发布人）不再能看到别人的采购单据
 */
export async function visiblePurchaseRequestScope(
  userId: string,
  role: string,
): Promise<Prisma.PurchaseRequestWhereInput> {
  if (!userId || role === 'ADMIN') return {}
  if (isPurchaseDept(await getUserDeptName(userId))) return {}
  const grants = await prisma.purchaseScopeGrant.findMany({
    where: { userId },
    select: { scopeType: true, scopeId: true },
  })
  const grantReqIds = grants.filter((g) => g.scopeType === 'PURCHASE_REQUEST').map((g) => g.scopeId!)
  const hasAll = grants.some((g) => g.scopeType === 'PURCHASE_ALL')
  if (hasAll) return {}
  return {
    OR: [
      { requesterId: userId },
      { handlerId: userId },
      ...(grantReqIds.length > 0 ? [{ id: { in: grantReqIds } }] : []),
    ],
  }
}

export async function visiblePurchaseOrderScope(
  userId: string,
  role: string,
): Promise<Prisma.PurchaseOrderWhereInput> {
  if (!userId || role === 'ADMIN') return {}
  if (isPurchaseDept(await getUserDeptName(userId))) return {}
  const grants = await prisma.purchaseScopeGrant.findMany({
    where: { userId },
    select: { scopeType: true, scopeId: true },
  })
  const grantOrderIds = grants.filter((g) => g.scopeType === 'PURCHASE_ORDER').map((g) => g.scopeId!)
  const hasAll = grants.some((g) => g.scopeType === 'PURCHASE_ALL')
  if (hasAll) return {}
  return {
    OR: [
      { creatorId: userId },
      { ownerId: userId },
      { receiverId: userId },
      // ★ Step3：发布人链路——工程师发布清单后经 supplierRequest→request→requesterId
      // 可见对应订单进度（与 purchase-workflow.notifyOrderAdvanced 通知 requester 对齐）
      { supplierRequest: { request: { requesterId: userId } } },
      ...(grantOrderIds.length > 0 ? [{ id: { in: grantOrderIds } }] : []),
    ],
  }
}

/**
 * 品牌采购任务（SupplierRequest）可见：与清单同口径
 *   采购部/ADMIN 全量；其余=任务创建人 ∪ 溯源清单发布人（角色矩阵②③进度只读）∪ 被授权单据
 */
export async function visibleSupplierRequestScope(
  userId: string,
  role: string,
): Promise<Prisma.SupplierRequestWhereInput> {
  if (!userId || role === 'ADMIN') return {}
  if (isPurchaseDept(await getUserDeptName(userId))) return {}
  const grants = await prisma.purchaseScopeGrant.findMany({
    where: { userId },
    select: { scopeType: true, scopeId: true },
  })
  if (grants.some((g) => g.scopeType === 'PURCHASE_ALL')) return {}
  const grantReqIds = grants.filter((g) => g.scopeType === 'PURCHASE_REQUEST').map((g) => g.scopeId!)
  return {
    OR: [
      { creatorId: userId },
      // 发布人链路：清单发布人可见由该清单分解出的采购任务（进度只读）
      { request: { requesterId: userId } },
      ...(grantReqIds.length > 0 ? [{ request: { id: { in: grantReqIds } } }] : []),
    ],
  }
}

/**
 * ★ V3 兼容旧名：v2 的两个 filter 保留（内部转发新口径），存量调用点逐步迁移
 */
export async function visiblePurchaseOrderFilter(
  userId: string,
  role: string,
): Promise<Prisma.PurchaseOrderWhereInput> {
  return visiblePurchaseOrderScope(userId, role)
}

export async function visiblePurchaseRequestFilter(
  userId: string,
  role: string,
  deptName?: string | null,
): Promise<Prisma.PurchaseRequestWhereInput> {
  return visiblePurchaseRequestScope(userId, role)
}

// ═══════════════ 项目费用模块可见性（★ F2 2026-08-24；R2 报销单+明细重构）═══════════════

/** 是否财务部（按部门名包含「财务」判断） */
export function isFinanceDept(deptName: string | null | undefined): boolean {
  return !!deptName && deptName.includes(FINANCE_DEPT_KEYWORD)
}

/** 便捷版：一步判定用户是否费用全量可见者（ADMIN / 财务部） */
export async function isExpenseFinanceViewer(
  userId: string,
  role: string,
): Promise<boolean> {
  // ★ P2-5：!userId 显式不可见（false），防未来调用点漏 requireAuth 时全量放行
  if (role === 'ADMIN') return true
  if (!userId) return false
  return isFinanceDept(await getUserDeptName(userId))
}

/**
 * ★ F2 报销单统一可见过滤（用户强调的硬性要求）：
 *   ADMIN → 全量；财务部（部门名含「财务」）→ 全量；
 *   其余 → 仅报销人本人（payeeId 或 createdById == 当前用户）
 *   ★ 项目 OWNER/MANAGER/其他成员一律不可见（不可见=不可达：列表过滤+详情403+统计只计可见）
 *   金额不做脱敏——不可见即不返回记录。
 */
export async function visibleExpenseClaimScope(
  userId: string,
  role: string,
): Promise<Prisma.ExpenseClaimWhereInput> {
  // ★ P2-5：!userId 时显式不可见（in: []），防未来调用点漏 requireAuth 时全量泄露
  if (role === 'ADMIN') return {}
  if (!userId) return { id: { in: [] } }
  if (isFinanceDept(await getUserDeptName(userId))) return {}
  return { OR: [{ payeeId: userId }, { createdById: userId }] }
}

/** 单条报销单可见判定（详情 403 用；与 visibleExpenseClaimScope 同口径） */
export function canViewExpenseClaim(
  claim: { payeeId: string; createdById: string },
  userId: string,
  role: string,
  isFinance: boolean,
): boolean {
  if (role === 'ADMIN') return true
  if (isFinance) return true
  return claim.payeeId === userId || claim.createdById === userId
}
