/**
 * 登录速率限制（2026-08-22 深度评测 P1-3 修复）
 *
 * 内存级滑动窗口：按「账号 + IP」维度计数，
 *   5 次失败 → 锁定 15 分钟；锁定期内即使密码正确也拒绝。
 * 单进程内存实现（standalone 单实例足够）；多实例部署需换 Redis 等共享存储。
 */

interface FailEntry {
  count: number
  lockedUntil: number | null
  firstFailAt: number
}

const WINDOW_MS = 15 * 60 * 1000 // 15 分钟窗口
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000 // 锁定 15 分钟

const store = new Map<string, FailEntry>()

// 定期清理过期条目，防止内存膨胀
setInterval(() => {
  const now = Date.now()
  for (const k of Array.from(store.keys())) {
    const v = store.get(k)
    if (v && now - v.firstFailAt > WINDOW_MS * 2) store.delete(k)
  }
}, 10 * 60 * 1000).unref?.()

function key(account: string, ip: string): string {
  return `${account.toLowerCase().trim()}|${ip}`
}

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

/** 登录前检查：是否被锁定 */
export function isLoginLocked(account: string, ip: string): { locked: boolean; retryAfterSec?: number } {
  const e = store.get(key(account, ip))
  if (!e) return { locked: false }
  const now = Date.now()
  if (e.lockedUntil && e.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) }
  }
  return { locked: false }
}

/** 记录一次失败（超过阈值则锁定） */
export function recordLoginFail(account: string, ip: string) {
  const k = key(account, ip)
  const now = Date.now()
  const e = store.get(k)
  if (!e || now - e.firstFailAt > WINDOW_MS) {
    store.set(k, { count: 1, lockedUntil: null, firstFailAt: now })
    return false
  }
  e.count += 1
  if (e.count >= MAX_FAILS) {
    e.lockedUntil = now + LOCK_MS
    e.count = 0
    return true // 触发锁定
  }
  return false
}

/** 登录成功：清除失败记录 */
export function clearLoginFails(account: string, ip: string) {
  store.delete(key(account, ip))
}

/** 暴露配置（供测试/管理） */
export const loginRateLimitConfig = { MAX_FAILS, WINDOW_MS, LOCK_MS }
