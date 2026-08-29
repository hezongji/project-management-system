/**
 * 管理端 service —— 依据《开发文档-项目管理系统重构》§7.10
 * 走 src/services/api.ts 统一解包（§4 响应壳），供 /settings 页四个 tab 使用。
 */

import { ApiService } from './api'
import type { ApiResponse } from '@/types'

/** 解包 ApiResponse<T>.data（成功时必有 data） */
function unwrap<T>(res: ApiResponse<T>): T {
  return res.data as T
}

// ───────────────────────────── 类型 ─────────────────────────────

export interface AdminUser {
  id: string
  email: string
  username: string
  name: string
  role: 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'
  isActive: boolean
  departmentId: string | null
  departmentName: string | null
  jobTitle: string | null
  duties: string | null
  phone: string | null
  lastLoginAt: string | null
  createdAt: string
}

export interface Pagination {
  page: number
  limit: number
  total: number
  pages: number
}

export interface AdminUserPage {
  items: AdminUser[]
  pagination: Pagination
}

export interface AuditLog {
  id: string
  projectId: string | null
  projectName: string | null
  projectCode: string | null
  userId: string
  userName: string | null
  userEmail: string | null
  action: string
  detail: unknown
  createdAt: string
}

export interface AuditLogPage {
  items: AuditLog[]
  pagination: Pagination
}

export interface StorageItem {
  projectId: string
  projectName: string
  projectCode: string | null
  fileCount: number
  totalBytes: number
  quotaBytes: number
}

export interface StorageStats {
  items: StorageItem[]
  totalBytes: number
  totalFileCount: number
  quotaPerProjectBytes: number
}

export interface AdminSettings {
  registerEnabled: boolean
  storageQuotaPerProjectBytes: number
}

/** 数据清理：五类可清理垃圾的类型标识 */
export type CleanupType =
  | 'draftPurchaseOrders'
  | 'emptyProjects'
  | 'emptyPhases'
  | 'unusedExternalOrgs'
  | 'orphanFiles'

/** 数据清理：GET /admin/cleanup-stats 响应（各类可清理数量） */
export interface CleanupStats {
  draftPurchaseOrders: number
  emptyProjects: number
  emptyPhases: number
  unusedExternalOrgs: number
  orphanFiles: number
}

/** 权限 V2：用户权限配置（GET /admin/permissions/:id 响应） */
export interface PermissionConfig {
  user: {
    id: string
    username: string
    name: string
    role: 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'
    isActive: boolean
    departmentName: string | null
  }
  config: {
    pagePermissions: string[] | null // null = 按角色默认
    resolvedPages: string[] // 最终生效页面
    extraVisibleProjectIds: string[]
  }
}

// ───────────────────────────── 方法 ─────────────────────────────

export const AdminService = {
  /** 项目下拉选项（审计筛选用） */
  getProjectOptions: () =>
    ApiService.get<{ items: Array<{ id: string; name: string; code: string }> }>(
      '/projects?limit=100'
    ).then((r) => unwrap(r).items),

  /** 用户管理列表 */
  getUsers: (params: { q?: string; page?: number; limit?: number }) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    search.set('page', String(params.page ?? 1))
    search.set('limit', String(params.limit ?? 100))
    return ApiService.get<AdminUserPage>(`/admin/users?${search.toString()}`).then(unwrap)
  },

  /** 更新用户（启停/角色/部门） */
  updateUser: (input: {
    userId: string
    isActive?: boolean
    role?: 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'
    departmentId?: string | null
    name?: string
    email?: string
    phone?: string | null
    jobTitle?: string | null
    duties?: string | null
  }) => ApiService.patch<AdminUser>('/admin/users', input).then(unwrap),

  /** 新增用户（单人新增；密码缺省 123456） */
  createUser: (input: {
    name: string
    email?: string
    username?: string
    password?: string
    phone?: string | null
    departmentId?: string | null
    jobTitle?: string | null
    duties?: string | null
    role?: 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'
  }) => ApiService.post<AdminUser>('/admin/users', input).then(unwrap),

  /** 删除用户（存在业务引用时后端 400 拒绝） */
  deleteUser: (id: string) => ApiService.delete<{ id: string; name: string }>(`/admin/users/${id}`).then(unwrap),

  /** 管理员重置用户密码（P1-5 兜底） */
  resetUserPassword: (input: { userId: string; newPassword: string }) =>
    ApiService.post<{ id: string; email: string; username: string; name: string }>(
      '/admin/users/reset-password',
      input
    ).then(unwrap),

  /** 审计日志 */
  getAuditLogs: (params: {
    projectId?: string
    userId?: string
    action?: string
    page?: number
    limit?: number
  }) => {
    const search = new URLSearchParams()
    if (params.projectId) search.set('projectId', params.projectId)
    if (params.userId) search.set('userId', params.userId)
    if (params.action) search.set('action', params.action)
    search.set('page', String(params.page ?? 1))
    search.set('limit', String(params.limit ?? 20))
    return ApiService.get<AuditLogPage>(`/admin/audit-logs?${search.toString()}`).then(unwrap)
  },

  /** 存储统计 */
  getStorage: () => ApiService.get<StorageStats>('/admin/storage').then(unwrap),

  /** 读取系统设置 */
  getSettings: () =>
    ApiService.get<{ settings: AdminSettings }>('/admin/settings').then((r) => unwrap(r).settings),

  /** 更新系统设置 */
  updateSettings: (settings: Partial<AdminSettings>) =>
    ApiService.patch<{ settings: AdminSettings }>('/admin/settings', { settings }).then((r) =>
      unwrap(r).settings
    ),

  // ── 数据清理（2026-08-23 删除工程 t7：ADMIN 垃圾数据清理）──

  /** 各类可清理垃圾统计（只读） */
  getCleanupStats: () =>
    ApiService.get<CleanupStats>('/admin/cleanup-stats').then(unwrap),

  /** 按类型执行批量清理（事务 + 审计） */
  runCleanup: (type: CleanupType) =>
    ApiService.post<{ type: CleanupType; deleted: number }>('/admin/cleanup', { type }).then(unwrap),

  // ── 权限 V2（2026-08-21）：权限分配 ──

  /** 查看用户权限配置 */
  getUserPermissions: (userId: string) =>
    ApiService.get<PermissionConfig>
      (`/admin/permissions/${userId}`).then(unwrap),

  /** 保存用户权限配置 */
  saveUserPermissions: (
    userId: string,
    input: { pagePermissions?: string[] | null; extraVisibleProjectIds?: string[] },
  ) => ApiService.put<{ message: string }>(`/admin/permissions/${userId}`, input).then(unwrap),
}
