'use client'

/**
 * FocusRing —— 定位高亮包装器
 *
 * 当 focusId 匹配自身 id 时：平滑滚动到该元素（视口中央）并播放
 * 高亮闪烁动画（ring + 背景呼吸），3s 后自然消退。
 *
 * 用在任务看板卡片、文件条目行、消息气泡、采购单行等任意条目容器上。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function FocusRing({
  id,
  focusId,
  children,
  className,
  scrollBlock = 'center',
  onFocused,
}: {
  id: string
  focusId: string | null | undefined
  children: ReactNode
  className?: string
  scrollBlock?: 'center' | 'start' | 'nearest'
  /** 命中回调（可用于埋点/滚动父容器切换 tab 等） */
  onFocused?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [flashing, setFlashing] = useState(false)
  const hit = !!focusId && focusId === id

  useEffect(() => {
    if (!hit || !ref.current) return
    // 等一帧让布局稳定（列表虚拟化/图片加载后再滚）
    const raf = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: scrollBlock })
    })
    setFlashing(true)
    onFocused?.()
    const t = setTimeout(() => setFlashing(false), 3000)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit])

  return (
    <div
      ref={ref}
      data-focus-id={id}
      className={cn(
        'rounded-md transition-shadow duration-300',
        hit && flashing && 'focus-ring-flash',
        className
      )}
    >
      {children}
    </div>
  )
}
