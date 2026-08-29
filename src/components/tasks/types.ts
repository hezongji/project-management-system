/**
 * 任务模块前端类型 —— 依据《开发文档-项目管理系统重构》§5 / §7.6 / §8.2③
 * 与 GET /api/tasks/:id 响应载荷对齐（Date 字段经 JSON 序列化为 string）。
 */

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE' | 'CANCELLED'
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
export type AnnotationColor = 'yellow' | 'red' | 'blue' | 'green'

export interface UserBrief {
  id: string
  name: string
  email?: string
  avatar?: string | null
}

/** 按钮级权限摘要（§4.7：由 API data.permissions 驱动，前端不自算） */
export interface TaskPerms {
  view: boolean
  edit: boolean
  delete: boolean
  assign: boolean
  upload: boolean
  download: boolean
  approve: boolean
  archive: boolean
}

/** 修订快照（六字段白名单，dueDate 为 ISO 串或 null） */
export interface TaskSnapshot {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  dueDate: string | null
}

export interface TaskRevisionItem {
  id: string
  taskId: string
  version: number
  changeSummary: string
  snapshot: TaskSnapshot
  changedById: string
  changedBy: UserBrief
  createdAt: string
}

export interface TaskAnnotationItem {
  id: string
  taskId: string
  userId: string
  user: UserBrief
  field: string | null
  color: AnnotationColor
  note: string
  resolved: boolean
  createdAt: string
}

export interface TaskCommentItem {
  id: string
  taskId: string
  userId: string
  user: UserBrief
  content: string
  mentions: string[] | null
  createdAt: string
}

export interface TaskDetail {
  id: string
  phaseId: string | null
  projectId: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  assignee: UserBrief | null
  creatorId: string
  creator: UserBrief | null
  dueDate: string | null
  startedAt: string | null
  completedAt: string | null
  revision: number
  createdAt?: string
  updatedAt?: string
  phase: { id: string; code: string; name: string; status: string } | null
  project: { id: string; code: string; name: string; isArchived: boolean }
  revisions: TaskRevisionItem[]
  annotations: TaskAnnotationItem[]
  comments: TaskCommentItem[]
  permissions: TaskPerms
  mentionCandidates: (UserBrief & { title: string | null })[]
}

/** 列表行（GET /api/tasks items） */
export interface TaskListItem {
  id: string
  phaseId: string | null
  projectId: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  assignee: UserBrief | null
  creator: UserBrief | null
  dueDate: string | null
  revision: number
  phase?: { id: string; code: string; name: string } | null
  project?: { id: string; code: string; name: string }
  _count?: { annotations: number; revisions: number; comments: number }
}

// ───────────────────────────── 显示辅助 ─────────────────────────────

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  REVIEW: '待评审',
  DONE: '已完成',
  CANCELLED: '已取消',
}

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
}

/** 快照字段中文标签（diff/标注锚点展示用） */
export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  assigneeId: '负责人',
  assignee: '负责人',
  dueDate: '截止日期',
  phase: '所属阶段',
}

/** 快照字段值的显示化（枚举/日期/空值 → 中文可读） */
export function displaySnapshotValue(
  field: string,
  value: unknown,
  candidates?: { id: string; name: string }[],
): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (field === 'status') return TASK_STATUS_LABEL[value as TaskStatus] ?? String(value)
  if (field === 'priority') return TASK_PRIORITY_LABEL[value as TaskPriority] ?? String(value)
  if (field === 'assigneeId') {
    const u = candidates?.find((c) => c.id === value)
    return u ? u.name : String(value)
  }
  if (field === 'dueDate') {
    const d = new Date(String(value))
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('zh-CN')
  }
  const s = String(value)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}
