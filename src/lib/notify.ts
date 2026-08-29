'use client'

/**
 * 桌面通知（§8.2⑥「桌面通知: Notification API（页面隐藏时），设置可关」）
 *
 * 规则：
 *   - 仅在页面隐藏（document.hidden）且用户已授权（Notification.permission === 'granted'）
 *     且「设置开关」开启时才会弹通知
 *   - 点击通知：focus 窗口 + 跳转 link（可选）
 *   - 开关存 localStorage（pm-notify-enabled，默认开）
 *   - 所有 window/Notification/localStorage 访问均做 SSR 安全防护
 */

const STORAGE_KEY = 'pm-notify-enabled'

/** 是否开启桌面通知（localStorage 开关，默认开） */
export function isNotifyEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const v = localStorage.getItem(STORAGE_KEY)
  return v !== '0' // 缺省视为开启；'0' 视为关闭
}

/** 设置桌面通知开关（true=开 / false=关） */
export function setNotifyEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // ignore（隐私模式等场景 localStorage 可能抛异常）
  }
}

/** 请求通知权限（仅当浏览器支持且处于 default 未决状态时） */
export function requestNotifyPermission(): void {
  if (typeof window === 'undefined') return
  if (!('Notification' in window)) return
  try {
    if (Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  } catch {
    // ignore
  }
}

/** 是否已获桌面通知授权 */
export function isNotifyGranted(): boolean {
  if (typeof window === 'undefined') return false
  if (!('Notification' in window)) return false
  return Notification.permission === 'granted'
}

/**
 * 弹桌面通知（满足条件才弹）。
 * @param title 标题
 * @param body  正文（可选）
 * @param link  点击后跳转路径（可选，同源路径如 /messages?conversation=x）
 */
export function notify(title: string, body?: string, link?: string): void {
  if (typeof window === 'undefined') return
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  if (!isNotifyEnabled()) return
  if (!document.hidden) return // 页面可见时不弹（§8.2⑥ 页面隐藏时）

  try {
    const n = new Notification(title, {
      body: body ?? '',
      icon: '/favicon.ico',
      tag: link ?? title, // 同 tag 去重，避免同类通知堆叠
    })
    n.onclick = () => {
      window.focus()
      if (link) {
        // 同源路径跳转，避免注入外部 URL
        window.location.href = link.startsWith('/') ? link : '/'
      }
      n.close()
    }
  } catch {
    // 部分移动端/权限异常时静默失败
  }
}
