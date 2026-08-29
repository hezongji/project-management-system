/**
 * 文件服务层 —— §7.7（submit / upload / download / preview）
 *
 * - submit：POST /api/file-requirements/:id/submit（multipart）
 * - uploadPlanFile：POST /api/files/upload（multipart + catalogId）
 * - download：GET /api/files/:id/download（blob → 浏览器触发保存）
 * - preview：GET /api/files/:id/preview（blob → objectURL 供 iframe/img 内联）
 *
 * 下载/预览带 Bearer token（axios 拦截器自动附加），用 responseType blob
 * 接收字节流后本地建 objectURL，规避 <a href> 直链无法携带 Authorization 头的问题。
 */

import { api, ApiService } from './api'
import { ApiResponse } from '@/types'
import type { UploadedFileDto } from '@/types/file'

/**
 * 404 视为磁盘文件缺失（seed/迁移导致 storagePath 无实体），转成友好提示，
 * 避免“请求失败（HTTP 404）”白屏（见 audit P1-4）。
 */
function missingFileError(e: unknown): Error {
  if (e && typeof e === 'object' && (e as { status?: number }).status === 404) {
    return new Error('文件已丢失（磁盘文件缺失，可能已被清理）')
  }
  return e instanceof Error ? e : new Error(String(e))
}

export class FileService {
  /** 条目提交（版本递增）：POST /api/file-requirements/:id/submit */
  static async submit(
    requirementId: string,
    file: File,
    onProgress?: (p: number) => void,
  ): Promise<ApiResponse<{ file: UploadedFileDto; requirement: { id: string; status: string } }>> {
    return ApiService.upload<{ file: UploadedFileDto; requirement: { id: string; status: string } }>(
      `/file-requirements/${requirementId}/submit`,
      file,
      onProgress,
    )
  }

  /** 计划外临时文件上传：POST /api/files/upload */
  static async uploadPlanFile(
    catalogId: string,
    file: File,
    onProgress?: (p: number) => void,
  ): Promise<ApiResponse<{ file: UploadedFileDto }>> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('catalogId', catalogId)
    const response = await api.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          onProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total))
        }
      },
    })
    return response.data as ApiResponse<{ file: UploadedFileDto }>
  }

  /** 下载：GET /api/files/:id/download（blob → 触发保存，服务端写 FileAccessLog） */
  static async download(fileId: string, filename: string): Promise<void> {
    let response
    try {
      response = await api.get(`/files/${fileId}/download`, { responseType: 'blob' })
    } catch (e) {
      throw missingFileError(e)
    }
    const blob = response.data as Blob
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** 预览：GET /api/files/:id/preview（blob → objectURL 供 iframe/img 内联） */
  static async preview(fileId: string): Promise<string> {
    let response
    try {
      response = await api.get(`/files/${fileId}/preview`, { responseType: 'blob' })
    } catch (e) {
      throw missingFileError(e)
    }
    const blob = response.data as Blob
    return URL.createObjectURL(blob)
  }
}
