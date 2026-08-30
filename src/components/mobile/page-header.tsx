'use client'

/**
 * MobilePageHeader —— 二级页/详情页页头（标题 + 可选返回 + 右侧动作槽）。
 * 与全局 Header 不同层：一级页用全局 Header，二级页内嵌本组件。
 * 返回按钮带 data-mobile-back 属性（验收打点）触控 ≥44px。
 */

import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

export function MobilePageHeader({
  title,
  onBack,
  right,
  sticky = true,
}: {
  title: React.ReactNode
  onBack?: () => void
  right?: React.ReactNode
  sticky?: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-12 min-h-11 items-center gap-2 border-b bg-card px-3',
        sticky && 'sticky top-0 z-30',
      )}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {onBack && (
        <button
          type="button"
          data-mobile-back
          aria-label="返回"
          onClick={onBack}
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-muted/60"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      <div className="min-w-0 flex-1 truncate text-base font-semibold">{title}</div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </div>
  )
}
