/**
 * 文件条目审核流 + 到期催办（file-review）—— 依据《开发文档-项目管理系统重构》
 * §5(FileStatusFm 七态) / §6.1(权限) / §7.7(approve|reject|na) / §7.9(催办·通知) / §9.4(IM 联动)
 *
 * 状态机（§5 FileStatusFm）：
 *   WAITING →(submit，P2-2)→ SUBMITTED →(审核)→ REVIEWING → APPROVED / REJECTED
 *   旁路：NA（不适用，项目 edit）/ OBSOLETED（作废，项目 edit）
 *
 * 职责（本模块被 approve/reject/na/obsolete 四条 API 路由 + scripts/remind-file-requirements.ts 复用）：
 *   1. approveRequirement(userId, id, comment)
 *      —— 审核人（权限在路由层用 requireCan('approve', FILE_REQ) 终审，§6.1 阶段负责人
 *         file.approve；默认阶段负责人=Phase.ownerId，由权限引擎运行时解析，不落死 reviewerId）
 *      —— 仅 SUBMITTED/REVIEWING 可审 → APPROVED；写 FileAccessLog(APPROVE)（挂最新版本文件）；
 *         通知责任人（Notification FILE_APPROVED + IM notify:push）；记 ActivityLog file.approve
 *   2. rejectRequirement(userId, id, comment)
 *      —— 同上 → REJECTED；写 FileAccessLog(REJECT)；通知责任人（FILE_PENDING_REVIEW，见下注）
 *   3. markRequirementNA(userId, id, reason)
 *      —— 项目 edit；status=NA + remark=reason（必填备注）；记 ActivityLog file.na
 *   4. obsoleteRequirement(userId, id, reason)
 *      —— 项目 edit；status=OBSOLETED + remark=reason；写 FileAccessLog(OBSOLETE)（若有文件）；
 *         记 ActivityLog file.obsolete
 *   5. remindDueRequirements({daysBefore, now})
 *      —— 到期前 N 天（默认 3）对 WAITING/SUBMITTED/REVIEWING 且 dueDate 在 N 天内（含已超期）
 *         的条目生成 TodoItem(sourceType=FILE_REQ, dueAt=条目 dueDate) + Notification(FILE_DUE_SOON)
 *         + IM notify:push；幂等：责任人已存在未完成 FILE_REQ 待办则跳过。
 *
 * 工程决策（文档未明示处，均在本模块注释与 docs/reports/P2-3.md 列明，可追溯）：
 *   - reject 通知类型用 FILE_PENDING_REVIEW（NotifType 无 FILE_REJECTED；驳回后责任人需重新提交，
 *     「待处理」语义最近）；approve 用 FILE_APPROVED；催办用 FILE_DUE_SOON
 *   - approve/reject 仅允许从 SUBMITTED/REVIEWING 进入（WAITING 尚无文件可审，REJECTED/NA/OBSOLETED
 *     为终态，重走需先 submit 复位）
 *   - FileAccessLog 挂在条目的最新版本文件（FileAccessLog.fileId 是必填外键；审批动作针对的是
 *     已上传文件，submit 已保证 SUBMITTED/REVIEWING 条目必有文件）；极端无文件时跳过 log 不阻塞
 *   - 责任人 ownerId 为空的条目：通知/待办挂到项目负责人（ProjectMember OWNER），与 phase-engine
 *     remindWaitingRequirements 口径一致
 *   - 催办待办优先级：已超期 HIGH / 到期前 MEDIUM（§5 TodoItem.priority 为 TaskPriority 枚举）
 *   - 通知链接统一 `/projects/{projectId}/files?requirementId={id}`
 *   - 本模块零 next/server 依赖（可独立单测）；业务错误抛 FileReviewError（带 status/code），
 *     由各路由以 toApiError 转换为 api-helpers.ApiError 统一响应壳
 */

import { prisma } from './prisma'
import { Prisma } from '@prisma/client'
import type { FileStatusFm, NotifType, FileAccessAction } from '@prisma/client'

// ───────────────────────────── 业务错误 ─────────────────────────────

/**
 * 文件审核流业务错误：路由层捕获后转换为 api-helpers 的 ApiError（含 status）。
 * （不直接复用 api-helpers.ApiError，保持本模块零 next/server 依赖，可独立单测。）
 */
export class FileReviewError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'BAD_REQUEST') {
    super(message)
    this.name = 'FileReviewError'
    this.status = status
    this.code = code
  }
}

// ───────────────────────────── 类型 ─────────────────────────────

type Tx = Prisma.TransactionClient

/** 可进入审核的状态（§5 状态机：SUBMITTED → REVIEWING → APPROVED/REJECTED） */
const REVIEWABLE_STATUSES: readonly FileStatusFm[] = ['SUBMITTED', 'REVIEWING']

/** 审核流操作结果（路由响应体 + 单测断言用） */
export interface ReviewOutcome {
  requirementId: string
  name: string
  code: string | null
  status: FileStatusFm
  projectId: string
  comment: string
  /** 写入 FileAccessLog 的动作（na 无对应枚举，记 null） */
  accessLogAction: FileAccessAction | null
  /** 是否实际落库了 FileAccessLog（条目无文件时为 false，不阻塞主流转） */
  logCreated: boolean
  /** 收到站内通知 / IM notify:push 的责任人 userId（可能含项目负责人兜底） */
  notifiedUserIds: string[]
}

/** 催办函数入参 */
export interface RemindOptions {
  /** 提前提醒天数，默认 3（§7.9「到期前 3 天」） */
  daysBefore?: number
  /** 基准时间（测试注入用），默认 now */
  now?: Date
}

/** 催办函数结果（脚本打印 + 单测断言用） */
export interface RemindResult {
  /** 命中「进行中 + 3 天内到期（含超期）」的条目总数 */
  scanned: number
  /** 本次新生成待办的条目数 */
  created: number
  /** 已存在未完成 FILE_REQ 待办而跳过的条目数（幂等） */
  skipped: number
  /** 无责任人（ownerId 空且无项目 OWNER）无法提醒的条目数 */
  noOwner: number
  /** 本次收到提醒（待办+通知+IM push）的去重责任人 userId */
  notifiedUserIds: string[]
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/** 条目上下文（含项目冗余信息与负责人） */
interface RequirementContext {
  id: string
  name: string
  code: string | null
  status: FileStatusFm
  projectId: string
  phaseCode: string | null
  ownerId: string | null
  project: { code: string; name: string; isArchived: boolean }
}

async function getRequirementContext(tx: Tx, id: string): Promise<RequirementContext> {
  const req = await tx.fileRequirement.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      projectId: true,
      phaseCode: true,
      ownerId: true,
      project: { select: { code: true, name: true, isArchived: true } },
    },
  })
  if (!req) throw new FileReviewError(404, '文件条目不存在', 'NOT_FOUND')
  return req
}

/** 条目责任人：ownerId 优先，为空兜底项目负责人（ProjectMember OWNER），仍无则 null */
async function resolveOwnerId(tx: Tx, req: RequirementContext): Promise<string | null> {
  if (req.ownerId) return req.ownerId
  const owner = await tx.projectMember.findFirst({
    where: { projectId: req.projectId, role: 'OWNER' },
    select: { userId: true },
  })
  return owner?.userId ?? null
}

/** 条目站内跳转链接（2026-08-21 修复：文件页路由为 /files，非 /projects/:id/files） */
function reqLink(req: RequirementContext): string {
  return `/files?projectId=${req.projectId}&requirementId=${req.id}`
}

/** IM notify:push（§9.4）：事务内 PG NOTIFY im_events，提交时投递、回滚不发出 */
async function pushNotify(
  tx: Tx,
  userId: string,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
    event: 'notify:push',
    userId,
    title,
    body,
    link,
  })})`
}

/**
 * 通知责任人（站内 Notification + IM notify:push）。
 * approve → FILE_APPROVED；reject → FILE_PENDING_REVIEW（见文件头注）。
 * 返回去重后的责任人 userId 列表（无责任人则空）。
 */
async function notifyOwner(
  tx: Tx,
  req: RequirementContext,
  verdict: 'APPROVED' | 'REJECTED',
  comment: string,
): Promise<string[]> {
  const target = await resolveOwnerId(tx, req)
  if (!target) return []

  const approved = verdict === 'APPROVED'
  const type: NotifType = approved ? 'FILE_APPROVED' : 'FILE_PENDING_REVIEW'
  const title = approved ? `文件已通过审核：${req.name}` : `文件被驳回：${req.name}`
  const body = approved
    ? comment
      ? `审核意见：${comment}`
      : `「${req.name}」已通过审核`
    : `驳回意见：${comment || '未填写'}，请修改后重新提交`
  const link = reqLink(req)

  await tx.notification.create({ data: { userId: target, type, title, body, link } })
  await pushNotify(tx, target, title, body, link)
  return [target]
}

/** 写 FileAccessLog（挂条目的最新版本文件）；无文件返回 false，不阻塞主流转 */
async function logAccess(
  tx: Tx,
  req: RequirementContext,
  userId: string,
  action: FileAccessAction,
): Promise<boolean> {
  const latest = await tx.file.findFirst({
    where: { requirementId: req.id },
    orderBy: { version: 'desc' },
    select: { id: true },
  })
  if (!latest) return false
  await tx.fileAccessLog.create({ data: { fileId: latest.id, userId, action } })
  return true
}

/** 记 ActivityLog（状态流转 + 备注/意见） */
async function logActivity(
  tx: Tx,
  req: RequirementContext,
  userId: string,
  action: string,
  from: FileStatusFm,
  to: FileStatusFm,
  note: string,
): Promise<void> {
  await tx.activityLog.create({
    data: {
      projectId: req.projectId,
      userId,
      action,
      detail: { requirementId: req.id, name: req.name, status: [from, to], note },
    },
  })
}

// ───────────────────────────── 公开接口（§7.7）─────────────────────────────

/** POST /api/file-requirements/:id/approve —— 审核通过（审核人权限，路由层终审） */
export async function approveRequirement(
  userId: string,
  requirementId: string,
  comment: string,
): Promise<ReviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const req = await getRequirementContext(tx, requirementId)
    if (!REVIEWABLE_STATUSES.includes(req.status)) {
      throw new FileReviewError(
        409,
        `当前状态 ${req.status} 不可审核（仅 SUBMITTED / REVIEWING 可审核）`,
        'CONFLICT',
      )
    }
    await tx.fileRequirement.update({
      where: { id: requirementId },
      data: { status: 'APPROVED' },
    })
    const logCreated = await logAccess(tx, req, userId, 'APPROVE')
    const notifiedUserIds = await notifyOwner(tx, req, 'APPROVED', comment)
    await logActivity(tx, req, userId, 'file.approve', req.status, 'APPROVED', comment)
    return {
      requirementId,
      name: req.name,
      code: req.code,
      status: 'APPROVED',
      projectId: req.projectId,
      comment,
      accessLogAction: 'APPROVE',
      logCreated,
      notifiedUserIds,
    }
  })
}

/** POST /api/file-requirements/:id/reject —— 审核驳回（审核人权限，路由层终审） */
export async function rejectRequirement(
  userId: string,
  requirementId: string,
  comment: string,
): Promise<ReviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const req = await getRequirementContext(tx, requirementId)
    if (!REVIEWABLE_STATUSES.includes(req.status)) {
      throw new FileReviewError(
        409,
        `当前状态 ${req.status} 不可审核（仅 SUBMITTED / REVIEWING 可审核）`,
        'CONFLICT',
      )
    }
    await tx.fileRequirement.update({
      where: { id: requirementId },
      data: { status: 'REJECTED' },
    })
    const logCreated = await logAccess(tx, req, userId, 'REJECT')
    const notifiedUserIds = await notifyOwner(tx, req, 'REJECTED', comment)
    await logActivity(tx, req, userId, 'file.reject', req.status, 'REJECTED', comment)
    return {
      requirementId,
      name: req.name,
      code: req.code,
      status: 'REJECTED',
      projectId: req.projectId,
      comment,
      accessLogAction: 'REJECT',
      logCreated,
      notifiedUserIds,
    }
  })
}

/** POST /api/file-requirements/:id/na —— 标记不适用（项目 edit，reason 必填备注） */
export async function markRequirementNA(
  userId: string,
  requirementId: string,
  reason: string,
): Promise<ReviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const req = await getRequirementContext(tx, requirementId)
    if (req.status === 'NA') {
      throw new FileReviewError(409, '该条目已标记为不适用', 'CONFLICT')
    }
    await tx.fileRequirement.update({
      where: { id: requirementId },
      data: { status: 'NA', remark: reason },
    })
    await logActivity(tx, req, userId, 'file.na', req.status, 'NA', reason)
    return {
      requirementId,
      name: req.name,
      code: req.code,
      status: 'NA',
      projectId: req.projectId,
      comment: reason,
      accessLogAction: null,
      logCreated: false,
      notifiedUserIds: [],
    }
  })
}

/** POST /api/file-requirements/:id/obsolete —— 作废（项目 edit，reason 必填备注） */
export async function obsoleteRequirement(
  userId: string,
  requirementId: string,
  reason: string,
): Promise<ReviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const req = await getRequirementContext(tx, requirementId)
    if (req.status === 'OBSOLETED') {
      throw new FileReviewError(409, '该条目已作废', 'CONFLICT')
    }
    await tx.fileRequirement.update({
      where: { id: requirementId },
      data: { status: 'OBSOLETED', remark: reason },
    })
    const logCreated = await logAccess(tx, req, userId, 'OBSOLETE')
    await logActivity(tx, req, userId, 'file.obsolete', req.status, 'OBSOLETED', reason)
    return {
      requirementId,
      name: req.name,
      code: req.code,
      status: 'OBSOLETED',
      projectId: req.projectId,
      comment: reason,
      accessLogAction: 'OBSOLETE',
      logCreated,
      notifiedUserIds: [],
    }
  })
}

// ───────────────────────────── 到期催办（§7.9）─────────────────────────────

/**
 * 到期催办：对 WAITING/SUBMITTED/REVIEWING 且 dueDate 在 daysBefore 天内（含已超期）的条目，
 * 生成 TodoItem(sourceType=FILE_REQ, dueAt=条目 dueDate) + Notification(FILE_DUE_SOON)
 * + IM notify:push 提醒责任人。
 *
 * 幂等：责任人名下已存在「未完成的 FILE_REQ 待办」（sourceId=条目 id）则跳过（不重复建待办/通知），
 * 适合 cron / 手动脚本周期性调用。
 */
export async function remindDueRequirements(
  options: RemindOptions = {},
): Promise<RemindResult> {
  const daysBefore = options.daysBefore ?? 3
  const now = options.now ?? new Date()
  const horizon = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000)

  return prisma.$transaction(async (tx) => {
    const reqs = await tx.fileRequirement.findMany({
      where: {
        status: { in: ['WAITING', 'SUBMITTED', 'REVIEWING'] },
        dueDate: { not: null, lte: horizon },
      },
      select: {
        id: true,
        name: true,
        code: true,
        phaseCode: true,
        projectId: true,
        ownerId: true,
        dueDate: true,
      },
      orderBy: { dueDate: 'asc' },
    })

    let created = 0
    let skipped = 0
    let noOwner = 0
    const notified: string[] = []

    for (const r of reqs) {
      const ownerId = r.ownerId ?? (await resolveProjectOwner(tx, r.projectId))
      if (!ownerId) {
        noOwner++
        continue
      }

      // 幂等：责任人名下已有未完成的同名 FILE_REQ 待办则跳过
      const existing = await tx.todoItem.findFirst({
        where: { sourceType: 'FILE_REQ', sourceId: r.id, userId: ownerId, doneAt: null },
        select: { id: true },
      })
      if (existing) {
        skipped++
        continue
      }

      const dueDate = r.dueDate as Date
      const overdue = dueDate.getTime() < now.getTime()
      const link = `/files?projectId=${r.projectId}&requirementId=${r.id}`
      const dueStr = dueDate.toISOString().slice(0, 10)
      const title = `文件催办：${r.name}`
      const body = overdue
        ? `「${r.name}」已超过截止日期（${dueStr}），请尽快提交`
        : `「${r.name}」将于 ${dueStr} 到期，请尽快提交`

      await tx.todoItem.create({
        data: {
          userId: ownerId,
          title: `【催办】${r.name}`,
          sourceType: 'FILE_REQ',
          sourceId: r.id,
          link,
          dueAt: dueDate,
          priority: overdue ? 'HIGH' : 'MEDIUM',
        },
      })
      await tx.notification.create({
        data: { userId: ownerId, type: 'FILE_DUE_SOON', title, body, link },
      })
      await pushNotify(tx, ownerId, title, body, link)

      created++
      if (!notified.includes(ownerId)) notified.push(ownerId)
    }

    return {
      scanned: reqs.length,
      created,
      skipped,
      noOwner,
      notifiedUserIds: notified,
    }
  })
}

/** 项目负责人 userId（无则 null） */
async function resolveProjectOwner(tx: Tx, projectId: string): Promise<string | null> {
  const owner = await tx.projectMember.findFirst({
    where: { projectId, role: 'OWNER' },
    select: { userId: true },
  })
  return owner?.userId ?? null
}
