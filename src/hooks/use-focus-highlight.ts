'use client'

/**
 * useFocusHighlight —— 跨页跳转"定位+高亮"基础设施
 *
 * 约定：目标页 URL 支持 ?focus=<条目id>（可选 &src=<来源标签>）。
 * 兼容历史参数：各页面把自家传统参数名（requirementId / orderId /
 * requestId / conversation 等）归一化为 focus 后传入本 hook 亦可。
 *
 * 用法：
 *   const { focusId, srcLabel, clearFocus } = useFocusHighlight()
 *   <FocusRing id={item.id} focusId={focusId}>…条目内容…</FocusRing>
 *
 * srcLabel 示例：'通知' / '消息卡片' / '待办' / '催办'，用于在页面顶部
 * 显示"已为你定位（来自通知）"的来源提示条。
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'

export function useFocusHighlight(extraKeys: string[] = []) {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  let focusId = sp.get('focus')
  if (!focusId) {
    for (const k of extraKeys) {
      const v = sp.get(k)
      if (v) {
        focusId = v
        break
      }
    }
  }
  const srcLabel = sp.get('src')

  // 高亮有效期：3.2s 后自动清除样式（避免用户交互后仍残留 ring）
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusId) return
    setActiveId(focusId)
    const t = setTimeout(() => setActiveId(null), 3200)
    return () => clearTimeout(t)
  }, [focusId])

  // 清除 URL 上的 focus/src 参数（高亮结束或用户关闭提示条时调用，避免刷新后重复定位）
  const clearFocus = useCallback(() => {
    if (!sp.get('focus') && !sp.get('src') && !extraKeys.some((k) => sp.get(k))) return
    const next = new URLSearchParams(sp.toString())
    next.delete('focus')
    next.delete('src')
    extraKeys.forEach((k) => next.delete(k))
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [sp, router, pathname, extraKeys])

  return { focusId, activeId, srcLabel, clearFocus }
}
