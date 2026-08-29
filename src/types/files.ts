/**
 * 文件目录管理（P2-1）前端类型 —— 依据《开发文档-项目管理系统重构》§7.7 / §8.2④
 * 与后端 catalogs / file-requirements / file-matrix 响应逐字段对齐（日期为 ISO 字符串）。
 */

export type FileStatus =
  | 'WAITING'
  | 'SUBMITTED'
  | 'REVIEWING'
  | 'APPROVED'
  | 'REJECTED'
  | 'NA'
  | 'OBSOLETED'

export type FileScope = 'PUBLIC' | 'RESTRICTED' | 'PRIVATE'

/** 目录树节点（含条目计数，递归 children） */
export interface CatalogNode {
  id: string
  projectId: string
  parentId: string | null
  name: string
  phaseCode: string | null
  order: number
  remark: string | null
  requirementCount: number
  requirements: { id: string; name: string; status: string }[]
  children: CatalogNode[]
}

/** 文件版本摘要（FileRequirement.files[]） */
export interface FileVersionSummary {
  id: string
  version: number
  name: string
  originalName: string
  size: number
  mimeType: string
  uploadedById: string
  uploadedBy: { id: string; name: string } | null
  createdAt: string
}

/** 8 键权限摘要（§6.2 permsOf，前端按钮驱动） */
export interface RequirementPerms {
  view: boolean
  edit: boolean
  delete: boolean
  assign: boolean
  upload: boolean
  download: boolean
  approve: boolean
  archive: boolean
}

/** 文件条目（§7.7 条目对象 + files 版本数组 + permissions） */
export interface FileRequirementItem {
  id: string
  name: string
  code: string | null
  required: boolean
  ownerId: string | null
  owner: { id: string; name: string } | null
  externalOrgId: string | null
  externalOrg: { id: string; name: string } | null
  purpose: string | null
  scope: FileScope
  scopeRefs: { userIds: string[]; deptIds: string[] } | null
  dueDate: string | null
  status: FileStatus
  reviewerId: string | null
  reviewer: { id: string; name: string } | null
  phaseCode: string | null
  catalogId: string
  catalog: { id: string; name: string }
  remark: string | null
  createdAt: string
  updatedAt: string
  files: FileVersionSummary[]
  permissions: RequirementPerms
}

export interface RequirementListData {
  items: FileRequirementItem[]
  pagination: { page: number; limit: number; total: number; pages: number }
  can: { create: boolean }
}

/** 计划外文件（临时文件，W4：PC 端文件移动） */
export interface AdhocFileItem {
  id: string
  name: string
  originalName: string
  size: number
  mimeType: string
  version: number
  checksum: string | null
  createdAt: string
  uploadedById: string
  uploadedBy: { id: string; name: string; email: string } | null
}

/** 我的待提交文件（2026-08-21 个人交付物：跨项目 mine 接口） */
export interface MyDeliverableItem {
  id: string
  name: string
  code: string | null
  phaseCode: string | null
  dueDate: string | null
  status: FileStatus
  remark: string | null
  overdue: boolean
  project: { id: string; code: string; name: string; status: string } | null
  catalog: { name: string } | null
  _count: { files: number }
}

export interface MyDeliverableListData {
  items: MyDeliverableItem[]
  pagination: { page: number; limit: number; total: number }
  stats: {
    waiting: number
    submitted: number
    rejected: number
    overdue: number
  }
}

/** 目录树响应 */
export interface CatalogTreeData {
  items: CatalogNode[]
  can: { create: boolean; edit: boolean; delete: boolean }
}

/** 项目成员选项（责任人/审核人下拉） */
export interface ProjectMemberOption {
  userId: string
  name: string
  role: string
  title: string | null
}

/** 新建/编辑条目入参 */
export interface RequirementInput {
  projectId: string
  catalogId: string
  name: string
  code?: string | null
  phaseCode?: string | null
  ownerId?: string | null
  externalOrgId?: string | null
  purpose?: string | null
  scope?: FileScope
  scopeRefs?: { userIds: string[]; deptIds: string[] } | null
  dueDate?: string | null
  required?: boolean
  reviewerId?: string | null
  remark?: string | null
}

/** Excel 导入结果 */
export interface RequirementImportResult {
  dryRun: boolean
  total: number
  validRows: number
  created?: number
  wouldCreate?: number
  skippedDuplicate?: number
  errors: { row: number; name: string; reason: string }[]
}

/** 文件矩阵分组计数（§7.7：条目×状态矩阵，六态计数） */
export interface FileMatrixCounts {
  waiting: number
  submitted: number
  reviewing: number
  approved: number
  rejected: number
  na: number
}

/** 文件矩阵分组（按 phaseCode + catalogId 分组） */
export interface FileMatrixGroup {
  phaseCode: string | null
  phaseName: string | null
  catalogId: string
  catalogName: string
  total: number
  required: number
  counts: FileMatrixCounts
}

/** 文件矩阵总表行（前端每行一条目） */
export interface FileMatrixRow {
  id: string
  name: string
  code: string | null
  required: boolean
  status: FileStatus
  owner: { id: string; name: string } | null
  phaseCode: string | null
  phaseName: string | null
  catalogId: string
  catalogName: string
  versionCount: number
}

/** 文件矩阵（归档核对表） */
export interface FileMatrixData {
  summary: {
    total: number
    required: number
    approved: number
    waiting: number
    submitted: number
    reviewing: number
    rejected: number
    na: number
    obsoleted: number
  }
  groups: FileMatrixGroup[]
  rows: FileMatrixRow[]
  missing: Array<{
    id: string
    name: string
    code: string | null
    status: FileStatus
    owner: { id: string; name: string } | null
    catalog: { id: string; name: string }
    dueDate: string | null
  }>
}

/** 归档拦截 400 响应体中的缺项条目（§7.7 {name,status,owner}） */
export interface ArchiveBlocker {
  name: string
  status: FileStatus
  owner: string | null
}
