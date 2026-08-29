/**
 * 文件目录管理 service —— 依据《开发文档-项目管理系统重构》§7.7 / §8.2④
 * 走 src/services/api.ts 统一解包（§4 响应壳），类型与 src/types/files.ts 对齐。
 */

import { ApiService } from './api'
import type { ApiResponse } from '@/types'
import type {
  AdhocFileItem,
  CatalogNode,
  CatalogTreeData,
  FileMatrixData,
  FileRequirementItem,
  MyDeliverableListData,
  ProjectMemberOption,
  RequirementImportResult,
  RequirementInput,
  RequirementListData,
} from '@/types/files'

function unwrap<T>(res: ApiResponse<T>): T {
  return res.data as T
}

export const FilesService = {
  // ───────────────────────── 目录树 ─────────────────────────

  getCatalogs: (projectId: string) =>
    ApiService.get<CatalogTreeData>(`/projects/${projectId}/catalogs`).then(unwrap),

  createCatalog: (
    projectId: string,
    input: { name: string; parentId?: string | null; phaseCode?: string | null; order?: number; remark?: string | null },
  ) => ApiService.post(`/projects/${projectId}/catalogs`, input),

  updateCatalog: (
    projectId: string,
    input: {
      id: string
      name?: string
      parentId?: string | null
      phaseCode?: string | null
      order?: number
      remark?: string | null
    },
  ) => ApiService.patch(`/projects/${projectId}/catalogs`, input),

  deleteCatalog: (projectId: string, catalogId: string) =>
    ApiService.delete(`/projects/${projectId}/catalogs?catalogId=${encodeURIComponent(catalogId)}`),

  // ───────────────────────── 文件条目 ─────────────────────────

  getRequirements: (params: {
    projectId: string
    catalogId?: string
    status?: string
    mine?: boolean
    overdue?: boolean
    page?: number
    limit?: number
  }) => {
    const search = new URLSearchParams()
    search.set('projectId', params.projectId)
    if (params.catalogId) search.set('catalogId', params.catalogId)
    if (params.status) search.set('status', params.status)
    if (params.mine) search.set('mine', '1')
    if (params.overdue) search.set('overdue', '1')
    search.set('page', String(params.page ?? 1))
    search.set('limit', String(params.limit ?? 20))
    return ApiService.get<RequirementListData>(`/file-requirements?${search.toString()}`).then(unwrap)
  },

  /** 单条目详情（跳转打开抽屉用） */
  getRequirement: (projectId: string, requirementId: string) =>
    ApiService.get<FileRequirementItem>(
      `/file-requirements/${requirementId}?projectId=${projectId}`,
    ).then(unwrap),

  // ───────────────────────── 计划外文件（临时文件，W4）─────────────────────────

  /** 计划外文件列表（按项目+目录） */
  getAdhocFiles: (projectId: string, catalogId: string) =>
    ApiService.get<{ items: AdhocFileItem[] }>(
      `/files?projectId=${encodeURIComponent(projectId)}&catalogId=${encodeURIComponent(catalogId)}`,
    ).then(unwrap),

  /** 移动计划外文件到项目内其他目录 */
  moveFile: (fileId: string, catalogId: string) =>
    ApiService.patch(`/files/${fileId}/move`, { catalogId }),


  /** 我的待提交文件（跨项目，工作台卡片） */
  getMyDeliverables: (params?: { page?: number; limit?: number }) => {
    const search = new URLSearchParams()
    search.set('page', String(params?.page ?? 1))
    search.set('limit', String(params?.limit ?? 10))
    return ApiService.get<MyDeliverableListData>(
      `/file-requirements/mine?${search.toString()}`,
    ).then(unwrap)
  },

  createRequirement: (input: RequirementInput) => ApiService.post('/file-requirements', input),

  updateRequirement: (id: string, input: Partial<RequirementInput>) =>
    ApiService.patch(`/file-requirements/${id}`, input),

  importRequirements: (projectId: string, file: File, dryRun = false) => {
    const form = new FormData()
    form.append('projectId', projectId)
    form.append('file', file)
    if (dryRun) form.append('dryRun', '1')
    return ApiService.postForm<RequirementImportResult>('/file-requirements/import', form).then(unwrap)
  },

  // ───────────────────────── 归档矩阵 ─────────────────────────

  getFileMatrix: (projectId: string) =>
    ApiService.get<FileMatrixData>(`/projects/${projectId}/file-matrix`).then(unwrap),

  // ───────────────────────── 归档（§7.4 POST /projects/:id/archive）────────────────────────

  /** 归档拦截：必需未通过 → 400（ApiError.errors = [{name,status,owner}]）；通过 → isArchived */
  archiveProject: (projectId: string) =>
    ApiService.post<{ project: { id: string; code: string; isArchived: boolean; archivedAt: string | null } }>(
      `/projects/${projectId}/archive`,
      {},
    ),

  // ───────────────────────── 项目成员（责任人/审核人下拉，复用 tree 的 members）────────────────────────

  getProjectMembers: (projectId: string) =>
    ApiService.get<{ members: ProjectMemberOption[] }>(`/projects/${projectId}/tree`).then(
      (r) => unwrap(r).members ?? [],
    ),
}

/** 展平目录树为可选目录列表（建条目下拉用，带层级缩进名） */
export function flattenCatalogs(nodes: CatalogNode[], depth = 0): CatalogNode[] {
  const out: CatalogNode[] = []
  for (const n of nodes) {
    out.push(n)
    out.push(...flattenCatalogs(n.children, depth + 1))
  }
  return out
}

/** 目录树 → 名称查找（导出时反查目录名） */
export function catalogNameById(nodes: CatalogNode[], id: string): string {
  for (const n of nodes) {
    if (n.id === id) return n.name
    const found = catalogNameById(n.children, id)
    if (found) return found
  }
  return ''
}

/** 目录 id 集合（含子孙，筛选当前目录时含子目录条目可选） */
export function catalogSubtreeIds(node: CatalogNode | null): string[] {
  if (!node) return []
  const ids = [node.id]
  for (const c of node.children) ids.push(...catalogSubtreeIds(c))
  return ids
}

/** 便于类型收敛的默认空列表 */
export const EMPTY_REQUIREMENT_ITEM: FileRequirementItem = {
  id: '',
  name: '',
  code: null,
  required: true,
  ownerId: null,
  owner: null,
  externalOrgId: null,
  externalOrg: null,
  purpose: null,
  scope: 'PUBLIC',
  scopeRefs: null,
  dueDate: null,
  status: 'WAITING',
  reviewerId: null,
  reviewer: null,
  phaseCode: null,
  catalogId: '',
  catalog: { id: '', name: '' },
  remark: null,
  createdAt: '',
  updatedAt: '',
  files: [],
  permissions: {
    view: false,
    edit: false,
    delete: false,
    assign: false,
    upload: false,
    download: false,
    approve: false,
    archive: false,
  },
}
