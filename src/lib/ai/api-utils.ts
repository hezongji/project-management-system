/**
 * AI 专项 API 上游工具：MiMo 错误归一化 + 配置前置检查
 * （JSON 抽取纯函数在 ./extract.ts，此处仅转出口保持路由统一 import）
 *
 * 设计：docs/设计方案-AI智能助手.md §五
 * MiMoError（超时/配额/未配 key）→ ApiError 统一壳，前端拿到友好提示而非 500。
 */
import { ApiError } from '../api-helpers'
import { MiMoError, mimoApiKey } from './mimo'

export { extractJsonArray, extractJsonObject } from './extract'

/** 将 MiMo 客户端错误转为统一 API 壳（§4）。路由内 catch 里 throw miMoToApiError(err)。 */
export function miMoToApiError(err: unknown): ApiError {
  if (err instanceof MiMoError) {
    if (err.message.includes('未配置')) {
      return new ApiError(503, 'AI 服务未配置，请联系管理员', 'AI_NOT_CONFIGURED')
    }
    if (err.message.includes('超时')) {
      return new ApiError(504, 'AI 服务响应超时，请稍后重试', 'AI_TIMEOUT')
    }
    const status = err.status >= 400 && err.status < 600 ? err.status : 502
    return new ApiError(502, `AI 服务暂时不可用（${status}）：${err.message.slice(0, 200)}`, 'AI_UPSTREAM_ERROR')
  }
  return new ApiError(500, 'AI 服务内部错误', 'AI_INTERNAL_ERROR')
}

/** 路由级调用前置检查：key 未配置直接短路，省得打一次上游 */
export function assertAiConfigured(): void {
  if (!mimoApiKey()) {
    throw new ApiError(503, 'AI 服务未配置，请联系管理员', 'AI_NOT_CONFIGURED')
  }
}
