/**
 * 任务修订引擎（task-service）—— 依据《开发文档-项目管理系统重构》§5 TaskRevision / §7.6
 *
 * 职责（全部在调用方传入的事务客户端 tx 内执行，保证原子性）：
 *   1. snapshotOf(task)：提取任务可修订字段快照（Json 存 TaskRevision.snapshot）
 *   2. validateChangeSummary(summary)：§7.6「修订说明 >10 字」校验
 *   3. applyRevision(tx, ...)：★修订流——快照旧值 → 写 TaskRevision(version=修订前 revision)
 *      → 应用 patch → task.revision+1；patch 无实际变更时拒绝（空修订）
 *   4. rollbackRevision(tx, ...)：回滚流——「回滚=生成新修订，快照当前值」
 *      （§7.6 字面语义）：先快照当前值入 TaskRevision，再恢复目标版本快照字段，
 *      revision+1。因此 N 次修订 + M 次回滚后 revision = 1+N+M（详见 P1-5 报告）。
 *
 * 设计决策（文档未明示处）：
 *   - 可修订字段白名单 REVISABLE_FIELDS = title/description/status/priority/
 *     assigneeId/dueDate（§5 Task 模型的内容性字段；phaseId 移动任务属结构变更，
 *     不入修订通道，走 PATCH 或后续阶段管理 API）
 *   - 快照只存白名单字段（回滚即整组恢复，diff 精确可比）
 *   - version = 修订前的 task.revision（快照内容 = 该版本时刻的任务状态），
 *     与 @@unique([taskId, version]) 配合保证版本序列 1..N 连续不重
 *   - 回滚自动生成的 changeSummary 不受 >10 字校验（那是用户 API 的输入约束）
 *   - dueDate 快照为 ISO 串或 null（Json 不能直接存 Date）
 */

import { Prisma, TaskStatus, TaskPriority } from '@prisma/client'
import { EngineError } from './phase-engine'

// ───────────────────────────── 类型与常量 ─────────────────────────────

/** 可修订字段白名单（§7.6 patch 允许的字段） */
export const REVISABLE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assigneeId',
  'dueDate',
] as const

export type RevisableField = (typeof REVISABLE_FIELDS)[number]

/** 任务可修订字段的值形态 */
export interface TaskSnapshot {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  dueDate: string | null // ISO 8601 或 null（Json 不存 Date）
}

/** patch 输入（dueDate 为日期串，由路由层 zod 保证形态） */
export type TaskPatch = Partial<{
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  dueDate: string | null
}>

/** 修订结果 */
export interface RevisionResult {
  /** 修订后的任务完整数据 */
  task: Prisma.TaskGetPayload<{}>
  /** 本次写入的修订记录 */
  revision: {
    id: string
    version: number
    changeSummary: string
    snapshot: TaskSnapshot
  }
  /** 本次修订前的快照（= 写入记录的 snapshot） */
  before: TaskSnapshot
}

type Tx = Prisma.TransactionClient

/** Task 实体（含 revision 字段）的最小投影 */
type TaskForSnapshot = {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  dueDate: Date | null
}

// ───────────────────────────── 校验 ─────────────────────────────

/**
 * §7.6：修订说明 changeSummary 必须 >10 字（trim 后按字符数计，中文一字一符）。
 * 仅约束用户直接调用的修订 API；回滚自动生成的说明不走此校验。
 */
export function validateChangeSummary(summary: unknown): string {
  if (typeof summary !== 'string') {
    throw new EngineError(400, 'changeSummary 必须为字符串')
  }
  const trimmed = summary.trim()
  if (trimmed.length <= 10) {
    throw new EngineError(
      400,
      `修订说明（changeSummary）必须超过 10 个字，当前 ${trimmed.length} 字：重大变更必须留下可追溯的说明`,
    )
  }
  return trimmed
}

/** patch 字段白名单过滤：丢弃非白名单字段并返回实际携带的字段名 */
export function pickPatchFields(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k): k is RevisableField =>
    (REVISABLE_FIELDS as readonly string[]).includes(k),
  )
}

// ───────────────────────────── 快照 ─────────────────────────────

/** 提取任务可修订字段快照（dueDate → ISO 串） */
export function snapshotOf(task: TaskForSnapshot): TaskSnapshot {
  return {
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId ?? null,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
  }
}

/** 两个快照是否有差异（空修订检测 / 回滚必要性检测） */
export function snapshotDiffers(a: TaskSnapshot, b: TaskSnapshot): boolean {
  return (
    a.title !== b.title ||
    a.description !== b.description ||
    a.status !== b.status ||
    a.priority !== b.priority ||
    a.assigneeId !== b.assigneeId ||
    a.dueDate !== b.dueDate
  )
}

/** 计算两快照间的字段级 diff（修订时间线渲染用）：返回有差异的字段 {old,new} */
export function diffSnapshots(
  oldSnap: TaskSnapshot,
  newSnap: TaskSnapshot,
): Partial<Record<RevisableField, { old: TaskSnapshot[RevisableField]; new: TaskSnapshot[RevisableField] }>> {
  const out: Partial<
    Record<RevisableField, { old: unknown; new: unknown }>
  > = {}
  for (const field of REVISABLE_FIELDS) {
    if (oldSnap[field] !== newSnap[field]) {
      out[field] = { old: oldSnap[field], new: newSnap[field] }
    }
  }
  return out as never
}

/** patch → Prisma 更新数据（白名单已由路由层 zod 保证形态） */
function patchToUpdateData(patch: TaskPatch): Prisma.TaskUpdateInput {
  const data: Prisma.TaskUpdateInput = {}
  if (patch.title !== undefined) data.title = patch.title
  if (patch.description !== undefined) data.description = patch.description
  if (patch.status !== undefined) data.status = patch.status
  if (patch.priority !== undefined) data.priority = patch.priority
  if (patch.assigneeId !== undefined) {
    data.assignee = patch.assigneeId
      ? { connect: { id: patch.assigneeId } }
      : { disconnect: true }
  }
  if (patch.dueDate !== undefined) {
    data.dueDate = patch.dueDate ? new Date(patch.dueDate) : null
  }
  return data
}

/** 快照 → Prisma 恢复数据（回滚用，六字段全量写回） */
function snapshotToRestoreData(snap: TaskSnapshot): Prisma.TaskUpdateInput {
  return patchToUpdateData({
    title: snap.title,
    description: snap.description,
    status: snap.status,
    priority: snap.priority,
    assigneeId: snap.assigneeId,
    dueDate: snap.dueDate,
  })
}

// ───────────────────────────── 事务内取任务投影 ─────────────────────────────

async function getTaskForRevision(tx: Tx, taskId: string) {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      assigneeId: true,
      dueDate: true,
      revision: true,
    },
  })
  if (!task) throw new EngineError(404, `任务不存在：${taskId}`, 'NOT_FOUND')
  return task
}

// ───────────────────────────── ★修订流（§7.6） ─────────────────────────────

/**
 * 修订：快照旧值 → TaskRevision(version=修订前 revision) → 应用 patch → revision+1。
 * 全部在 tx 内；patch 应用后与修订前无任何字段差异时拒绝（防空修订刷版本号）。
 */
export async function applyRevision(
  tx: Tx,
  taskId: string,
  userId: string,
  changeSummary: string,
  patch: TaskPatch,
): Promise<RevisionResult> {
  const summary = validateChangeSummary(changeSummary)

  // patch 至少携带一个白名单字段
  const fields = pickPatchFields(patch as Record<string, unknown>)
  if (fields.length === 0) {
    throw new EngineError(
      400,
      `patch 不能为空，且只允许字段：${REVISABLE_FIELDS.join(', ')}`,
    )
  }

  const task = await getTaskForRevision(tx, taskId)
  const before = snapshotOf(task)

  // assigneeId 目标值存在性校验（连接失败会 500，提前给出 400 人类可读错误）
  if (patch.assigneeId) {
    const target = await tx.user.findUnique({
      where: { id: patch.assigneeId },
      select: { id: true },
    })
    if (!target) {
      throw new EngineError(400, `assigneeId 不存在：${patch.assigneeId}`)
    }
  }

  // 预演：合并 patch 后的快照，无差异则拒绝
  const after: TaskSnapshot = {
    ...before,
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.priority !== undefined && { priority: patch.priority }),
    ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
    ...(patch.dueDate !== undefined && {
      dueDate: patch.dueDate ? new Date(patch.dueDate).toISOString() : null,
    }),
  }
  if (!snapshotDiffers(before, after)) {
    throw new EngineError(
      400,
      'patch 未产生任何字段变更（新旧值相同），已拒绝空修订',
    )
  }

  // ① 快照旧值入 TaskRevision（version = 修订前 revision，快照=该版本时刻状态）
  const revision = await tx.taskRevision.create({
    data: {
      taskId: task.id,
      version: task.revision,
      changeSummary: summary,
      changedById: userId,
      snapshot: before as unknown as Prisma.InputJsonValue,
    },
  })

  // ② 应用 patch + revision+1
  const updated = await tx.task.update({
    where: { id: task.id },
    data: { ...patchToUpdateData(patch), revision: task.revision + 1 },
  })

  return {
    task: updated,
    revision: {
      id: revision.id,
      version: revision.version,
      changeSummary: revision.changeSummary,
      snapshot: before,
    },
    before,
  }
}

// ───────────────────────────── 回滚流（§7.6） ─────────────────────────────

/**
 * 回滚到指定版本：「回滚=生成新修订，快照当前值」——
 *   ① 以当前值生成一条新修订记录（version=当前 revision，快照=回滚前状态，
 *      changeSummary 自动生成，不受 >10 字输入校验）
 *   ② 恢复目标版本快照的六字段，revision+1
 * 目标版本不存在 / 内容已与目标一致时拒绝。
 */
export async function rollbackRevision(
  tx: Tx,
  taskId: string,
  userId: string,
  targetVersion: number,
): Promise<RevisionResult> {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new EngineError(400, `回滚目标版本非法：${targetVersion}`)
  }

  const task = await getTaskForRevision(tx, taskId)

  const target = await tx.taskRevision.findUnique({
    where: { taskId_version: { taskId: task.id, version: targetVersion } },
  })
  if (!target) {
    throw new EngineError(
      404,
      `版本 v${targetVersion} 不存在（任务 ${task.title} 当前 revision=${task.revision}）`,
      'NOT_FOUND',
    )
  }

  const current = snapshotOf(task)
  const targetSnap = target.snapshot as unknown as TaskSnapshot

  if (!snapshotDiffers(current, targetSnap)) {
    throw new EngineError(
      400,
      `任务当前内容已与版本 v${targetVersion} 一致，无需回滚`,
    )
  }

  // ① 新修订：快照当前值（version=当前 revision，保证版本序列连续不重）
  const revision = await tx.taskRevision.create({
    data: {
      taskId: task.id,
      version: task.revision,
      changeSummary: `回滚至版本 v${targetVersion}（原说明：${target.changeSummary}）`,
      changedById: userId,
      snapshot: current as unknown as Prisma.InputJsonValue,
    },
  })

  // ② 恢复目标快照六字段 + revision+1
  const updated = await tx.task.update({
    where: { id: task.id },
    data: { ...snapshotToRestoreData(targetSnap), revision: task.revision + 1 },
  })

  return {
    task: updated,
    revision: {
      id: revision.id,
      version: revision.version,
      changeSummary: revision.changeSummary,
      snapshot: current,
    },
    before: current,
  }
}
