/**
 * 组织架构 service —— 依据《开发文档-项目管理系统重构》§7.2
 * 走 src/services/api.ts 统一解包（§4 响应壳），类型与 src/lib/org-tree.ts 对齐。
 */

import { ApiService } from './api'
import type { ApiResponse } from '@/types'
import type { DeptNode } from '@/lib/org-tree'

/** 解包 ApiResponse<T>.data（成功时必有 data） */
function unwrap<T>(res: ApiResponse<T>): T {
  return res.data as T
}

// ───────────────────────────── 类型 ─────────────────────────────

export interface DeptMemberBrief {
  id: string
  name: string
  email: string
  jobTitle: string | null
  duties: string | null
  phone: string | null
  avatar: string | null
  role: 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'
  isActive: boolean
  createdAt: Date
}

export interface DepartmentInput {
  name: string
  parentId?: string | null
  managerId?: string | null
  sort?: number
}

export interface JobTitleItem {
  id: string
  name: string
  deptHint: string | null
  sort: number
  userCount: number
  stageCount: number
}

export interface JobTitleInput {
  name?: string
  deptHint?: string | null
  sort?: number
}

export type ExternalOrgTypeLabel = 'CUSTOMER' | 'SUPPLIER' | 'OUTSOURCER' | 'CONTRACTOR' | 'OTHER'

export interface ExternalContact {
  id: string
  orgId: string
  name: string
  title: string | null
  phone: string | null
  email: string | null
  remark?: string | null
}

export interface ExternalOrg {
  id: string
  name: string
  type: ExternalOrgTypeLabel
  phone: string | null
  address: string | null
  remark: string | null
  isActive: boolean
  contacts: ExternalContact[]
  _count?: { contacts: number }
}

export interface ExternalOrgInput {
  name?: string
  type?: ExternalOrgTypeLabel
  phone?: string | null
  address?: string | null
  remark?: string | null
  isActive?: boolean
}

export interface ImportRowError {
  row: number
  name: string
  email?: string
  reason: string
}

export interface ImportResult {
  dryRun: boolean
  total: number
  created?: number
  updated?: number
  validRows?: number
  wouldCreate?: number
  wouldUpdate?: number
  createdOrgs?: number
  updatedOrgs?: number
  addedContacts?: number
  wouldCreateOrgs?: number
  wouldUpdateOrgs?: number
  wouldAddContacts?: number
  errors: ImportRowError[]
}

export interface OrgChart {
  departments: DeptNode[]
  externals: Record<string, Array<{ id: string; name: string; isActive: boolean; contactCount: number }>>
  stats: { userTotal: number; deptTotal: number; externalTotal: number }
}

export const ORG_TYPE_LABEL_MAP: Record<ExternalOrgTypeLabel, string> = {
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  OUTSOURCER: '外协',
  CONTRACTOR: '外包商',
  OTHER: '其他',
}

// ───────────────────────────── 部门 ─────────────────────────────

export const OrgService = {
  /** 部门树（含成员数/负责人/在职成员摘要） */
  getDepartments: () => ApiService.get<{ items: DeptNode[] }>('/departments').then((r) => unwrap(r).items),

  createDepartment: (input: DepartmentInput) => ApiService.post('/departments', input),
  updateDepartment: (id: string, input: Partial<DepartmentInput>) =>
    ApiService.patch(`/departments/${id}`, input),
  deleteDepartment: (id: string) => ApiService.delete(`/departments/${id}`),

  // ───────────────────────── 岗位字典 ─────────────────────────

  getJobTitles: () => ApiService.get<{ items: JobTitleItem[] }>('/job-titles').then((r) => unwrap(r).items),
  createJobTitle: (input: JobTitleInput) => ApiService.post('/job-titles', input),
  updateJobTitle: (id: string, input: JobTitleInput) => ApiService.patch(`/job-titles/${id}`, input),
  deleteJobTitle: (id: string) => ApiService.delete(`/job-titles/${id}`),

  // ───────────────────────── 外部主体 ─────────────────────────

  getExternalOrgs: (params: {
    type?: ExternalOrgTypeLabel | ''
    q?: string
    page?: number
    limit?: number
  }) => {
    const search = new URLSearchParams()
    if (params.type) search.set('type', params.type)
    if (params.q) search.set('q', params.q)
    search.set('page', String(params.page ?? 1))
    search.set('limit', String(params.limit ?? 20))
    return ApiService.get<{
      items: ExternalOrg[]
      pagination: { page: number; limit: number; total: number; pages: number }
    }>(`/external-orgs?${search.toString()}`).then((r) => unwrap(r))
  },

  createExternalOrg: (input: ExternalOrgInput) => ApiService.post('/external-orgs', input),
  updateExternalOrg: (id: string, input: ExternalOrgInput) =>
    ApiService.patch(`/external-orgs/${id}`, input),
  deleteExternalOrg: (id: string) => ApiService.delete(`/external-orgs/${id}`),

  getContacts: (orgId: string) =>
    ApiService.get<{ items: ExternalContact[] }>(`/external-orgs/${orgId}/contacts`).then(
      (r) => unwrap(r).items
    ),
  createContact: (
    orgId: string,
    input: { name: string; title?: string | null; phone?: string | null; email?: string | null; remark?: string | null }
  ) => ApiService.post(`/external-orgs/${orgId}/contacts`, input),
  updateContact: (
    orgId: string,
    contactId: string,
    input: { name?: string; title?: string | null; phone?: string | null; email?: string | null; remark?: string | null }
  ) => ApiService.patch(`/external-orgs/${orgId}/contacts/${contactId}`, input),
  deleteContact: (orgId: string, contactId: string) =>
    ApiService.delete(`/external-orgs/${orgId}/contacts/${contactId}`),

  // ───────────────────────── 架构图数据 ─────────────────────────

  getOrgChart: () => ApiService.get<OrgChart>('/org-chart').then(unwrap),

  // ───────────────────────── Excel 导入 ─────────────────────────

  importUsers: (file: File, dryRun = false) => {
    const form = new FormData()
    form.append('file', file)
    if (dryRun) form.append('dryRun', '1')
    return ApiService.postForm<ImportResult>('/users/import', form).then(unwrap)
  },
  importExternalOrgs: (file: File, dryRun = false) => {
    const form = new FormData()
    form.append('file', file)
    if (dryRun) form.append('dryRun', '1')
    return ApiService.postForm<ImportResult>('/external-orgs/import', form).then(unwrap)
  },
}
