/**
 * 阶段下钻页（§8.2② 四区契约）前端类型 —— 与 GET /api/phases/:id 聚合响应对齐
 */

export type PhaseStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'SKIPPED'
  | 'PAUSED'

export type TaskStatus =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'REVIEW'
  | 'DONE'
  | 'CANCELLED'

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'

/** 检查项（Phase.checklist JSON 元素） */
export interface ChecklistItem {
  text: string
  checked: boolean
  checkedBy: string | null
  checkedAt: string | null
}

export interface PhaseOwner {
  id: string
  name: string
  email?: string
  avatar: string | null
  jobTitle?: string | null
}

/** 下钻聚合里的任务卡（含计数与负责人摘要） */
export interface PhaseTaskCard {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  assignee: { id: string; name: string; avatar: string | null } | null
  dueDate: string | null
  revision: number
  startedAt: string | null
  completedAt: string | null
  _count: { annotations: number; revisions: number; comments: number }
  permissions: { view: boolean; edit: boolean }
}

/** 文件版本（FileRequirement.files[] 元素） */
export interface FileVersionDto {
  id: string
  name: string
  originalName: string
  size: number
  mimeType: string
  version: number
  uploadedById: string
  uploadedBy: { id: string; name: string } | null
  createdAt: string
}

export type FileStatus =
  | 'WAITING'
  | 'SUBMITTED'
  | 'REVIEWING'
  | 'APPROVED'
  | 'REJECTED'
  | 'NA'
  | 'OBSOLETED'

/** 文件条目（§7.7 条目对象对齐，含 permissions 摘要） */
export interface FileRequirementDto {
  id: string
  name: string
  code: string | null
  required: boolean
  ownerId: string | null
  owner: { id: string; name: string } | null
  purpose: string | null
  dueDate: string | null
  status: FileStatus
  reviewerId: string | null
  reviewer: { id: string; name: string } | null
  catalog: { id: string; name: string }
  files: FileVersionDto[]
  permissions: { view: boolean; upload: boolean; approve: boolean }
}

/** 成员（项目成员 + 本阶段负责人标记） */
export interface PhaseMemberDto {
  userId: string
  name: string
  avatar: string | null
  jobTitle: string | null
  role: 'OWNER' | 'MANAGER' | 'MEMBER' | 'VIEWER'
  title: string | null
  isPhaseOwner: boolean
}

/** 阶段动态（ActivityLog，detail 含 phaseId/phaseCode 过滤后） */
export interface PhaseActivityDto {
  id: string
  action: string
  detail: Record<string, unknown> | null
  createdAt: string
  user: { id: string; name: string; avatar: string | null }
}

/** 权限摘要（8 键，前端按钮驱动） */
export interface PermsDto {
  view: boolean
  edit: boolean
  delete: boolean
  assign: boolean
  upload: boolean
  download: boolean
  approve: boolean
  archive: boolean
}

/** GET /api/phases/:id 聚合载荷 */
export interface PhaseDetailDto {
  phase: {
    id: string
    projectId: string
    code: string
    name: string
    order: number
    status: PhaseStatus
    ownerId: string | null
    owner: PhaseOwner | null
    plannedStart: string | null
    plannedEnd: string | null
    actualStart: string | null
    actualEnd: string | null
    progress: number
    skippedNote: string | null
    checklist: ChecklistItem[] | string | null
  }
  project: {
    id: string
    code: string
    name: string
    status: string
    isArchived: boolean
  }
  taskColumns: Record<'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE', PhaseTaskCard[]>
  cancelledTasks: PhaseTaskCard[]
  fileRequirements: FileRequirementDto[]
  members: PhaseMemberDto[]
  activities: PhaseActivityDto[]
  permissions: PermsDto
  canMarkDone: { ok: boolean; reason?: string }
}
