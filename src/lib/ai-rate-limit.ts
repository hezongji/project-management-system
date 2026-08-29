/**
 * AI 接口限流（2026-08-22 生产加固）
 *
 * 按 userId 的内存滑动窗口：每用户 5 分钟内最多 30 次 AI 请求。
 * 目的：防单人刷接口打爆 MiMo Token Plan 配额 / 拖垮上游。
 * 单进程内存实现（standalone 单实例足够）；多实例部署需换 Redis 等共享存储。
 */

const WINDOW_MS = 5 * 60 * 1000
const MAX_REQUESTS = 30

const store = new Map<string, number[]>() // userId → 窗口内请求时间戳

function pruneExpired(userId: string, now: number): number[] {
  const stamps = store.get(userId)
  if (!stamps) return []
  const alive = stamps.filter((t) => now - t < WINDOW_MS)
  if (alive.length === 0) store.delete(userId)
  else store.set(userId, alive)
  return alive
}

// 惰性全量清理：防止大量一次性用户撑爆内存（每 10 分钟一次，顺带兜底）
setInterval(() => {
  const now = Date.now()
  for (const k of Array.from(store.keys())) pruneExpired(k, now)
}, 10 * 60 * 1000).unref?.()

export interface AiRateLimitResult {
  allowed: boolean
  /** 超限时：距恢复可用的秒数 */
  retryAfterSec?: number
}

/** 检查并记录一次 AI 请求。调用点：requireAuth 之后立即执行。 */
export function checkAiRateLimit(userId: string): AiRateLimitResult {
  const now = Date.now()
  const alive = pruneExpired(userId, now)
  if (alive.length >= MAX_REQUESTS) {
    const oldest = Math.min(...alive)
    return { allowed: false, retryAfterSec: Math.ceil((oldest + WINDOW_MS - now) / 1000) }
  }
  alive.push(now)
  store.set(userId, alive)
  return { allowed: true }
}

/** 暴露配置（供测试/管理） */
export const aiRateLimitConfig = { MAX_REQUESTS, WINDOW_MS }
