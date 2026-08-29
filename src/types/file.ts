/**
 * 文件目录管理前端类型 —— 依据《开发文档-项目管理系统重构》§7.7 / §8.2④
 *
 * 条目详情抽屉（版本时间线 + 上传 + 下载/预览）的数据契约。
 * 与 types/phase.ts 的 FileRequirementDto / FileVersionDto 对齐并补充
 * download/checksum 等字段（下载留痕与 sha256 展示）。
 */

import type { FileStatus, FileVersionDto } from './phase'

/** 上传接口返回的文件对象（§7.7 submit / files/upload） */
export interface UploadedFileDto {
  id: string
  name: string
  originalName: string
  size: number
  mimeType: string
  checksum: string | null
  version: number
  createdAt: string
  uploadedById?: string
  uploadedBy?: { id: string; name: string } | null
}

/** 条目详情抽屉的入参（结构子集，兼容 FileRequirementDto 与全量权限形态） */
export interface FileRequirementDetailInput {
  id: string
  projectId?: string
  name: string
  code?: string | null
  status: FileStatus
  files: FileVersionDto[]
  permissions: {
    view?: boolean
    upload?: boolean
    download?: boolean
    approve?: boolean
  }
}

/** 短 sha256 展示（前 8 位 + …，供时间线 title 提示完整值） */
export function shortChecksum(checksum: string | null | undefined): string {
  if (!checksum) return ''
  return checksum.length > 12 ? `${checksum.slice(0, 12)}…` : checksum
}
