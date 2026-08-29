/**
 * 前端 API 调用层（axios 封装）—— P0-3 统一响应解包改造
 *
 * 约定（与 src/lib/api-helpers.ts 的 §4 响应壳对齐，但本文件运行在浏览器端，
 * ApiError 为前端轻量实现，不 import next/server 相关模块）：
 *   成功：{ success: true, data, message }
 *   失败：{ success: false, message, error: { code, message } }  → 抛 ApiError
 *   分页：data: { items: [...], pagination: { page, limit, total, pages } }
 *
 * 兼容策略（只改壳不动业务逻辑）：
 *   - 列表接口后端统一返回 data.items；getPaginated(listKey) 可将 items
 *     映射回旧键（projects/tasks 等），旧页面零改动。
 *   - baseURL 默认同源 '/api'（Next.js API Routes），NEXT_PUBLIC_API_URL
 *     显式配置时才指向外部网关。
 */

import axios, { AxiosError } from 'axios'
import { ApiResponse, PaginatedResponse, PaginationParams } from '@/types'

// ───────────────────────────── ApiError（前端轻量版） ─────────────────────────────

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly errors?: unknown[]

  constructor(status: number, message: string, code = 'ERROR', errors?: unknown[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.errors = errors
  }
}

/** 统一响应壳（与服务端 api-helpers 的 ApiOk/ApiFail 对齐） */
interface UnifiedBody {
  success: boolean
  data?: unknown
  message?: string
  error?: { code: string; message: string }
  errors?: unknown[]
}

/** 统一 axios 实例（导出供新组件直接使用：自带 token 拦截器与响应壳解包前的原始响应） */
export const api = axios.create({
  baseURL: `${process.env.NEXT_PUBLIC_API_URL || ''}/api`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use(
  (config) => {
    // SSR 阶段无 localStorage，仅浏览器端附加 token
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('auth-token')
      if (token) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

/**
 * 响应拦截：按统一壳解包
 *   - HTTP 2xx 且 success === false → 业务失败，抛 ApiError
 *   - HTTP 401 → 清理本地凭证并跳转登录页（保留旧行为）
 *   - HTTP 4xx/5xx → 抛 ApiError（优先取响应壳里的 message/error.code）
 */
api.interceptors.response.use(
  (response) => {
    const body = response.data as UnifiedBody | undefined
    if (body && typeof body === 'object' && body.success === false) {
      const err = new ApiError(
        response.status,
        body.message || body.error?.message || '请求失败',
        body.error?.code || 'BUSINESS_ERROR',
        body.errors
      )
      return Promise.reject(err)
    }
    return response
  },
  (error: AxiosError<UnifiedBody>) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('auth-token')
      localStorage.removeItem('auth-user')
      // 避免登录页自身 401 时死循环；带 next 回跳（W1-I3）
      if (!window.location.pathname.startsWith('/login')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?next=${next}`
      }
    }
    const status = error.response?.status ?? 0
    const body = error.response?.data
    return Promise.reject(
      new ApiError(
        status,
        body?.message || body?.error?.message || (status ? `请求失败（HTTP ${status}）` : '网络错误，请稍后重试'),
        body?.error?.code || 'HTTP_ERROR',
        body?.errors
      )
    )
  }
)

export class ApiService {
  static async get<T>(url: string, params?: any): Promise<ApiResponse<T>> {
    const response = await api.get(url, { params })
    return response.data
  }

  /** timeout 可选：AI 等长耗时接口需要更长超时（默认走实例 15s） */
  static async post<T>(
    url: string,
    data: any,
    opts?: { timeout?: number },
  ): Promise<ApiResponse<T>> {
    const response = await api.post(url, data, opts?.timeout ? { timeout: opts.timeout } : undefined)
    return response.data
  }

  static async put<T>(url: string, data: any): Promise<ApiResponse<T>> {
    const response = await api.put(url, data)
    return response.data
  }

  static async patch<T>(url: string, data: any): Promise<ApiResponse<T>> {
    const response = await api.patch(url, data)
    return response.data
  }

  static async delete<T>(url: string): Promise<ApiResponse<T>> {
    const response = await api.delete(url)
    return response.data
  }

  static async upload<T>(url: string, file: File, onProgress?: (progress: number) => void): Promise<ApiResponse<T>> {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(url, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(progress)
        }
      },
    })
    return response.data
  }

  /** multipart 表单提交（可携带任意额外字段，如 dryRun） */
  static async postForm<T>(url: string, form: FormData): Promise<ApiResponse<T>> {
    const response = await api.post(url, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  }

  public static handleError(error: any): never {
    if (error instanceof ApiError) throw error
    if (error.response) {
      const { status, data } = error.response
      throw new ApiError(status, data?.message || `Request failed with status ${status}`)
    } else if (error.request) {
      throw new ApiError(0, 'No response received from server', 'NETWORK_ERROR')
    } else {
      throw new ApiError(0, 'Request setup failed', 'SETUP_ERROR')
    }
  }
}

export class PaginatedApiService {
  /**
   * 分页列表统一解包。
   * @param listKey 兼容旧页面的列表键（如 'projects' / 'tasks'）：
   *                后端已统一返回 data.items，这里同步映射到旧键，旧页面零改动。
   */
  static async getPaginated<T>(
    url: string,
    pagination: PaginationParams,
    filters?: any,
    listKey?: string
  ): Promise<PaginatedResponse<T>> {
    const params = {
      ...pagination,
      ...filters,
    }

    const response = await api.get(url, { params })
    const body = response.data as PaginatedResponse<T>

    // 统一壳（items）→ 旧键兼容映射
    if (listKey) {
      const items = (body.data?.items as T[] | undefined) ?? []
      return {
        ...body,
        data: {
          ...body.data,
          [listKey]: items,
          // 旧代码兼容：部分页面直接读 data 本身当数组
          ...(Array.isArray(body.data) ? {} : {}),
        },
      }
    }
    return body
  }
}
