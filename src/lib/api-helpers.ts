/**
 * 统一 API 响应约定（服务端）—— 依据《开发文档-项目管理系统重构》§4、§7
 *
 * 响应壳（§4）：
 *   成功：{ success: true, data: {...}, message: 'ok' }
 *   失败：{ success: false, message: '人类可读错误', error: { code, message }, errors?: [...] }
 *         （HTTP 4xx/5xx；error 为机器可读错误对象，与 message 冗余便于前端两用）
 *
 * 分页约定（§4）：
 *   请求：?page=1&limit=20（limit 上限 100）
 *   响应：data: { items: [...], pagination: { page, limit, total, pages } }
 *   ⚠️ 列表键统一为 items（旧 projects/tasks 键废弃），前端统一读 data.items
 *
 * 鉴权中间件（§4.3）：
 *   requireAuth(request) → AuthUser，未认证抛 ApiError(401)
 *   requireRole(user, ...roles) → 涉权操作不满足抛 ApiError(403)
 *   apiHandler(handler) → 统一捕获 ApiError / ZodError / 未知错误并输出统一壳
 */

import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import type { GlobalRole } from '@prisma/client'
import { getAuthUser, AuthUser } from './auth'

// ───────────────────────────── 类型 ─────────────────────────────

/** 机器可读错误对象（响应壳的 error 字段） */
export interface ApiErrorBody {
  code: string
  message: string
}

/** 统一分页元信息（§4） */
export interface Pagination {
  page: number
  limit: number
  total: number
  pages: number
}

/** 统一成功响应 */
export interface ApiOk<T> {
  success: true
  data: T
  message: string
}

/** 统一失败响应 */
export interface ApiFail {
  success: false
  message: string
  error: ApiErrorBody
  errors?: unknown[]
}

/** 分页数据载荷 */
export interface PaginatedData<T> {
  items: T[]
  pagination: Pagination
}

// ───────────────────────────── ApiError ─────────────────────────────

/**
 * API 业务错误：路由内任意位置 throw，由 apiHandler / handleApiError
 * 统一转换为 §4 约定的失败响应壳。status 直接对应 HTTP 状态码。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly errors?: unknown[]

  constructor(status: number, message: string, code?: string, errors?: unknown[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code ?? defaultCode(status)
    this.errors = errors
  }

  /** 快捷构造 */
  static badRequest(message: string, errors?: unknown[]) {
    return new ApiError(400, message, 'BAD_REQUEST', errors)
  }
  static unauthorized(message = '未认证或登录已过期') {
    return new ApiError(401, message, 'UNAUTHORIZED')
  }
  static forbidden(message = '没有执行该操作的权限') {
    return new ApiError(403, message, 'FORBIDDEN')
  }
  static notFound(message = '资源不存在') {
    return new ApiError(404, message, 'NOT_FOUND')
  }
  static internal(message = '服务器内部错误') {
    return new ApiError(500, message, 'INTERNAL_ERROR')
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 409:
      return 'CONFLICT'
    default:
      return 'INTERNAL_ERROR'
  }
}

// ───────────────────────────── 响应构造 ─────────────────────────────

/** 成功响应（可选自定义 message） */
export function ok<T>(data: T, message = 'ok', status = 200): NextResponse {
  const body: ApiOk<T> = { success: true, data, message }
  return NextResponse.json(body, { status })
}

/** 创建成功响应（201） */
export function created<T>(data: T, message = 'ok'): NextResponse {
  return ok(data, message, 201)
}

/** 分页成功响应：data = { items, pagination }（§4 分页约定） */
export function okPage<T>(
  items: T[],
  page: number,
  limit: number,
  total: number
): NextResponse {
  const data: PaginatedData<T> = {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  }
  return ok(data)
}

/** 失败响应（§4：success:false + message + error + 可选 errors） */
export function fail(
  status: number,
  message: string,
  code?: string,
  errors?: unknown[]
): NextResponse {
  const body: ApiFail = {
    success: false,
    message,
    error: { code: code ?? defaultCode(status), message },
    ...(errors ? { errors } : {}),
  }
  return NextResponse.json(body, { status })
}

// ───────────────────────────── 分页解析 ─────────────────────────────

export interface ParsedPagination {
  page: number
  limit: number
  skip: number
}

/** 解析 ?page=&limit=（§4），page≥1，limit∈[1,100] */
export function parsePagination(request: NextRequest, defaultLimit = 20): ParsedPagination {
  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const rawLimit = parseInt(searchParams.get('limit') || String(defaultLimit), 10)
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : defaultLimit))
  return { page, limit, skip: (page - 1) * limit }
}

// ───────────────────────────── 鉴权中间件 ─────────────────────────────

/**
 * 受保护接口鉴权（§4.3）：校验 Bearer Token。
 * 未认证（缺失/无效 token）→ throw ApiError(401)，由 apiHandler 统一输出。
 */
export function requireAuth(request: NextRequest): AuthUser {
  const user = getAuthUser(request)
  if (!user) {
    throw ApiError.unauthorized()
  }
  return user
}

/**
 * 涉权操作角色校验（§4.3）：全局角色不在允许集合内 → throw ApiError(403)。
 * 例：requireRole(user, 'ADMIN') / requireRole(user, 'ADMIN', 'PROJECT_MANAGER')
 */
export function requireRole(user: AuthUser, ...roles: GlobalRole[]): void {
  const role = user.role as GlobalRole
  if (!roles.includes(role)) {
    throw ApiError.forbidden(`需要角色：${roles.join(' / ')}`)
  }
}

// ───────────────────────────── 路由包装 ─────────────────────────────

/** 将任意路由内错误转换为统一失败响应壳 */
export function handleApiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return fail(error.status, error.message, error.code, error.errors)
  }
  // permission.ts 的同名 ApiError（requireCan 抑 403）：结构同构（status/code/message），
  // 鸭子类型兼容，避免两套类型互相 import 造成循环依赖
  if (
    error instanceof Error &&
    error.name === 'ApiError' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    const e = error as Error & { status: number; code?: string }
    return fail(e.status, e.message, e.code)
  }
  if (error instanceof ZodError) {
    return fail(400, '输入数据格式错误', 'VALIDATION_ERROR', error.errors)
  }
  console.error('[api] unhandled error:', error)
  return fail(500, '服务器内部错误')
}

/**
 * 路由高阶包装：
 *   export const GET = apiHandler(async (request) => { ... })
 * 内部 throw ApiError / ZodError 即自动转为 §4 统一失败壳，路由代码不再手写 try/catch。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<C = any>(
  handler: (request: NextRequest, context: C) => Promise<NextResponse>
): (request: NextRequest, context: C) => Promise<NextResponse> {
  return async (request, context) => {
    try {
      return await handler(request, context)
    } catch (error) {
      return handleApiError(error)
    }
  }
}
