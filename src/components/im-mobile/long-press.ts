'use client'

/**
 * 长按 hook（共享，v1.2 W3）
 * 500ms 阈值 + 12px 移动取消；返回 touch 事件处理器。
 */

import { useRef } from 'react'

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
      timer.current = setTimeout(() => onLongPress(t.clientX, t.clientY), 500)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (Math.abs(t.clientX - start.current.x) > 12 || Math.abs(t.clientY - start.current.y) > 12) {
        if (timer.current) clearTimeout(timer.current)
      }
    },
    onTouchEnd: () => {
      if (timer.current) clearTimeout(timer.current)
    },
    onTouchCancel: () => {
      if (timer.current) clearTimeout(timer.current)
    },
  }
  return handlers
}
