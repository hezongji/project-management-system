/**
 * 项目根树（PhaseTree）类型 —— 依据《开发文档-项目管理系统重构》§7.4 tree 响应契约、§8.2①
 * 与后端 src/app/api/projects/[id]/tree/route.ts 输出逐字段对齐（日期为 ISO 字符串）。
 */

export type PhaseStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'SKIPPED'
  | 'PAUSED'

export type ProjectRole = 'OWNER' | 'MANAGER' | 'MEMBER' | 'VIEWER' | 'ADMIN'

export interface TreeOwner {
  id: string
  name: string
  avatar: string | null
}

/** tree.phases[] 节点（§7.4 契约） */
export interface PhaseTreeNode {
  id: string
  code: string
  name: string
  order: number
  status: PhaseStatus
  owner: TreeOwner | null
  plannedStart: string | null
  plannedEnd: string | null
  actualEnd: string | null
  progress: number
  taskCount: number
  taskDone: number
  fileStats: { total: number; approved: number }
  delayed: boolean
}

/** tree.project（§7.4 契约） */
export interface TreeProject {
  id: string
  code: string
  name: string
  status: 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED'
  amount: number | null
  contractNo: string | null
  location: string | null
  signedAt: string | null
  plannedStart: string | null
  plannedEnd: string | null
  progress: number
  myRole: ProjectRole | null
  customer: { id: string; name: string } | null
  isArchived: boolean
  can: { edit: boolean; archive: boolean }
}

export interface TreeFileSummary {
  required: number
  approved: number
  waiting: number
  rejected: number
}

export interface TreeMember {
  userId: string
  name: string
  role: Exclude<ProjectRole, 'ADMIN'>
  title: string | null
}

/** GET /api/projects/:id/tree 响应 data */
export interface ProjectTreeData {
  project: TreeProject
  phases: PhaseTreeNode[]
  fileSummary: TreeFileSummary
  isLegacy: boolean
  members: TreeMember[]
}

/** 归档拦截 400 的 errors[] 条目（§7.7 示例） */
export interface ArchiveBlocker {
  name: string
  status: string
  owner: string | null
}
