/**
 * /api/analytics/overview —— 依据《开发文档-项目管理系统重构》§7.9
 *
 * GET 登录  图表页数据：项目状态分布 / 阶段漏斗 / 人员负载 / 文件及时率 / 回款进度
 *
 * 权限（§6.1）：
 *   - requireAuth；ADMIN 全量；普通用户只统计「自己参与的项目」
 *     （ProjectMember.userId = 本人）范围内的数据
 *   - ?projectId= 可选，传了则进一步限定单项目
 *     （若非 ADMIN 且非该项目成员 → requireCan('view', {type:'PROJECT', id}) 抛 403）
 *
 * 响应契约：
 *   { success:true, data: { projectStatusDist, phaseFunnel, memberLoad,
 *                           fileTimeliness, paymentProgress } }
 *
 * 五组字段口径：
 *   1. projectStatusDist：项目状态分布 [{status:'ACTIVE',count:N}, ...]
 *      —— 按 Project.status 聚合，固定返回 4 个枚举值（缺项补 0，顺序 ACTIVE/ON_HOLD/COMPLETED/CANCELLED）
 *   2. phaseFunnel：阶段漏斗 [{code:'PH01',name:'商务拜访',status:'DONE',projectCount:N}, ...]
 *      —— 多项目：按 phaseCode×status 聚合各项目同阶段的状态分布（用于「20 阶段漏斗」）
 *      —— 单项目（传了 projectId）：按该项目 phases 展开（order 升序），projectCount 恒为 1
 *      —— 阶段名取默认模板「标准交付流程20步」的 TemplateStage.name（PH01..PH20 规范名）
 *   3. memberLoad：人员负载 [{userId,name,taskTotal,taskDone,taskActive}, ...]
 *      —— 任务按 assigneeId 聚合；taskActive = 非 DONE 且非 CANCELLED
 *   4. fileTimeliness：文件及时率 [{label:'YYYY-MM',total,onTime}, ...]
 *      —— fileRequirement 按 dueDate 月份聚合；onTime = status==='APPROVED' 且无逾期
 *      —— 「无逾期」口径：dueDate 为空，或 dueDate >= 今天（截至统计时刻未逾期）。
 *         ⚠️ FileRequirement 无 approvedAt 字段，无法精确判定「通过时点是否晚于 dueDate」，
 *         故按「已通过 + 当前未逾期」估算及时率，属工程口径（如实标注，不擅自改 schema）
 *   5. paymentProgress：回款进度 —— ⚠️ 降级实现（设计缺口，如实标注）
 *      —— Project 模型没有回款字段（只有 amount 合同金额），故按项目 status 汇总合同金额：
 *         { note, items:[{projectId,name,amount,status}], summary:[{status,projectCount,amount}] }
 *      —— note 固定标注「回款字段缺失，降级为合同金额维度」；summary 为各状态合同金额合计
 *        （占比计算基础），items 为逐项目明细（未来接入真实回款字段后替换计算口径）
 *
 * 实现说明：
 *   - 计数/金额用 prisma groupBy（_count/_sum），需月维度分组的 fileTimeliness 用
 *     最小字段拉取后 JS 聚合（Prisma 无法跨库做 DATE_TRUNC 的通用 groupBy）
 *   - sqlite→PG 是 Prisma 层抽象，直接使用 prisma 客户端即可
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { phaseCodeOf } from '@/lib/phase-engine'
import { canViewFinance } from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

/** Project.status 枚举全集（固定顺序，缺项补 0） */
const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const
type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('projectId') || null

  // ── 权限与可见范围（§6.1）──
  // projectIds：null = 全量可见；数组 = 限定集合（非成员单项目已在 requireCan 被 403）
  let projectIds: string[] | null = null
  if (user.role === 'ADMIN') {
    if (projectId) {
      await requireCan(user.userId, 'view', { type: 'PROJECT', id: projectId })
      projectIds = [projectId]
    }
  } else if (projectId) {
    // 非 ADMIN 且非该项目成员 → 403（requireCan 内部走成员基线判定）
    await requireCan(user.userId, 'view', { type: 'PROJECT', id: projectId })
    projectIds = [projectId]
  } else {
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.userId },
      select: { projectId: true },
    })
    projectIds = memberships.map((m) => m.projectId)
  }

  const projectScope = projectIds === null ? {} : { id: { in: projectIds } }
  const childScope = projectIds === null ? {} : { projectId: { in: projectIds } }

  // ── 财务可见判定（权限 V2）：ADMIN / 财务部 / 单项目 OWNER・MANAGER ──
  const deptRow = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { department: { select: { name: true } } },
  })
  let memberRole: string | null = null
  if (projectIds && projectIds.length === 1) {
    const m = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: projectIds[0], userId: user.userId },
      },
      select: { role: true },
    })
    memberRole = m?.role ?? null
  }
  const finOk = canViewFinance(
    user.role,
    deptRow?.department?.name ?? null,
    memberRole,
  )

  // ── 1. projectStatusDist：项目状态分布 ──
  const statusGroup = await prisma.project.groupBy({
    by: ['status'],
    where: projectScope,
    _count: { _all: true },
  })
  const countByStatus = new Map<string, number>(
    statusGroup.map((g) => [g.status, g._count._all])
  )
  const projectStatusDist = PROJECT_STATUSES.map((s) => ({
    status: s,
    count: countByStatus.get(s) ?? 0,
  }))

  // ── 2. phaseFunnel：阶段漏斗 ──
  let phaseFunnel: { code: string; name: string; status: string; projectCount: number }[]
  if (projectIds !== null && projectIds.length === 1) {
    // 单项目：按该项目 phases 展开（order 升序），projectCount 恒为 1
    const phases = await prisma.phase.findMany({
      where: { projectId: projectIds[0] },
      select: { code: true, name: true, status: true },
      orderBy: { order: 'asc' },
    })
    phaseFunnel = phases.map((p) => ({
      code: p.code,
      name: p.name,
      status: p.status,
      projectCount: 1,
    }))
  } else {
    // 多项目：按 phaseCode × status 聚合（code 在项目内唯一，故计数即项目数）
    const grouped = await prisma.phase.groupBy({
      by: ['code', 'status'],
      where: childScope,
      _count: { _all: true },
    })
    // 阶段名取默认模板「标准交付流程20步」的规范名（PH01..PH20）
    const stages = await prisma.templateStage.findMany({
      where: { template: { isDefault: true } },
      select: { order: true, name: true },
      orderBy: { order: 'asc' },
    })
    const nameByCode = new Map<string, string>()
    for (const s of stages) nameByCode.set(phaseCodeOf(s.order), s.name)
    phaseFunnel = grouped
      .map((g) => ({
        code: g.code,
        name: nameByCode.get(g.code) ?? g.code,
        status: g.status,
        projectCount: g._count._all,
      }))
      .sort((a, b) => a.code.localeCompare(b.code) || a.status.localeCompare(b.status))
  }

  // ── 3. memberLoad：人员负载（任务按 assigneeId 聚合）──
  const tasks = await prisma.task.findMany({
    where: { ...childScope, assigneeId: { not: null } },
    select: { assigneeId: true, status: true },
  })
  const loadByAssignee = new Map<string, { total: number; done: number; active: number }>()
  for (const t of tasks) {
    const uid = t.assigneeId as string
    const cur = loadByAssignee.get(uid) ?? { total: 0, done: 0, active: 0 }
    cur.total += 1
    if (t.status === 'DONE') cur.done += 1
    if (t.status !== 'DONE' && t.status !== 'CANCELLED') cur.active += 1
    loadByAssignee.set(uid, cur)
  }
  const assigneeIds = Array.from(loadByAssignee.keys())
  const assignees = assigneeIds.length
    ? await prisma.user.findMany({
        where: { id: { in: assigneeIds } },
        select: { id: true, name: true },
      })
    : []
  const nameById = new Map(assignees.map((u) => [u.id, u.name]))
  const memberLoad = assigneeIds
    .map((uid) => {
      const v = loadByAssignee.get(uid) as { total: number; done: number; active: number }
      return {
        userId: uid,
        name: nameById.get(uid) ?? '',
        taskTotal: v.total,
        taskDone: v.done,
        taskActive: v.active,
      }
    })
    .sort((a, b) => b.taskTotal - a.taskTotal)

  // ── 4. fileTimeliness：文件及时率（按 dueDate 月份聚合）──
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const fileReqs = await prisma.fileRequirement.findMany({
    where: { ...childScope, dueDate: { not: null } },
    select: { dueDate: true, status: true },
  })
  const byMonth = new Map<string, { total: number; onTime: number }>()
  for (const f of fileReqs) {
    const d = f.dueDate as Date
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const cur = byMonth.get(label) ?? { total: 0, onTime: 0 }
    cur.total += 1
    // onTime = APPROVED 且无逾期（dueDate >= 今天）；无 approvedAt 字段，口径见文件头注
    if (f.status === 'APPROVED' && d >= today) cur.onTime += 1
    byMonth.set(label, cur)
  }
  const fileTimeliness = Array.from(byMonth.entries())
    .map(([label, v]) => ({ label, total: v.total, onTime: v.onTime }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // ── 5. paymentProgress：回款进度（降级为合同金额维度）──
  // ⚠️ Project 无回款字段，仅 amount 合同金额 → 按 status 汇总合同金额，并如实标注 note
  const projects = await prisma.project.findMany({
    where: projectScope,
    select: { id: true, name: true, amount: true, status: true },
    orderBy: { code: 'asc' },
  })
  const amountByStatus = await prisma.project.groupBy({
    by: ['status'],
    where: projectScope,
    _count: { _all: true },
    _sum: { amount: true },
  })
  const statusSummary = new Map<
    string,
    { projectCount: number; amount: number }
  >(
    amountByStatus.map((g) => [
      g.status,
      { projectCount: g._count._all, amount: g._sum.amount ? Number(g._sum.amount) : 0 },
    ])
  )
  const paymentProgress = {
    note: '回款字段缺失，降级为合同金额维度',
    items: projects.map((p) => ({
      projectId: p.id,
      name: p.name,
      // 脱敏口径统一（P2-5 修复）：无财务权限 → null（与 maskFinance 一致），避免 0 误导
      amount: finOk && p.amount !== null ? Number(p.amount) : null,
      status: p.status,
    })),
    summary: PROJECT_STATUSES.map((s) => ({
      status: s,
      projectCount: statusSummary.get(s)?.projectCount ?? 0,
      amount: finOk ? (statusSummary.get(s)?.amount ?? 0) : null,
    })),
  }

  return ok({
    projectStatusDist,
    phaseFunnel,
    memberLoad,
    fileTimeliness,
    paymentProgress,
  })
})
