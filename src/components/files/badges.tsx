'use client'

/**
 * 文件条目状态/范围徽章映射（files 各组件共用，§5 FileStatusFm / FileScope）
 */

import type { FileScope, FileStatus } from '@/types/files'

export const STATUS_BADGE: Record<FileStatus, { label: string; cls: string }> = {
  WAITING: { label: '待提交', cls: 'bg-slate-100 text-slate-600' },
  SUBMITTED: { label: '已提交', cls: 'bg-blue-100 text-blue-700' },
  REVIEWING: { label: '审核中', cls: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '已驳回', cls: 'bg-red-100 text-red-700' },
  NA: { label: '不适用', cls: 'bg-zinc-100 text-zinc-500' },
  OBSOLETED: { label: '已作废', cls: 'bg-zinc-200 text-zinc-500 line-through' },
}

export const STATUS_LABEL: Record<FileStatus, string> = Object.fromEntries(
  (Object.keys(STATUS_BADGE) as FileStatus[]).map((k) => [k, STATUS_BADGE[k].label]),
) as Record<FileStatus, string>

export const SCOPE_BADGE: Record<FileScope, { label: string; cls: string }> = {
  PUBLIC: { label: '项目公开', cls: 'bg-sky-100 text-sky-700' },
  RESTRICTED: { label: '指定范围', cls: 'bg-violet-100 text-violet-700' },
  PRIVATE: { label: '仅责任人', cls: 'bg-orange-100 text-orange-700' },
}

export const SCOPE_LABEL: Record<FileScope, string> = {
  PUBLIC: '项目公开',
  RESTRICTED: '指定范围',
  PRIVATE: '仅责任人',
}

export const ALL_STATUSES = Object.keys(STATUS_BADGE) as FileStatus[]

export function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}
