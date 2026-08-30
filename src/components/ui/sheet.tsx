'use client'

/**
 * Sheet —— 自绘底部抽屉（移动端通用容器）。
 * 参照 dialog.tsx 遮罩 + im-mobile/member-drawer 底部滑入手法，零新依赖。
 * 主题全走 CSS 变量；底部安全区 env(safe-area-inset-bottom)。
 */

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SheetProps {
  open: boolean
  onClose: () => void
  /** 顶部标题条（可空 = 无标题条） */
  title?: React.ReactNode
  children: React.ReactNode
  /** 底部固定操作条（按钮组） */
  footer?: React.ReactNode
  /** 内容区最大高度，默认 75dvh */
  maxHeight?: string
}

export function Sheet({ open, onClose, title, children, footer, maxHeight = '75dvh' }: SheetProps) {
  // 进场动画：挂载后下一帧解除 translate（CSS transition 生效）
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(raf)
    }
    setEntered(false)
  }, [open])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* 遮罩（同 dialog overlay） */}
      <div
        className={cn(
          'absolute inset-0 bg-black/50 transition-opacity duration-200',
          entered ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      {/* 面板：底部滑入 */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t bg-card text-card-foreground shadow-xl transition-transform duration-200 ease-out',
          entered ? 'translate-y-0' : 'translate-y-full',
        )}
        style={{
          maxHeight,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {title && (
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</div>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">{children}</div>
        {footer && <div className="shrink-0 border-t bg-card p-3">{footer}</div>}
      </div>
    </div>
  )
}
