'use client'

/**
 * MobileList / MobileListItem —— 移动端卡片流核心（替代表格行）。
 * 模式取自 im-mobile/conversation-list 行布局：触控行 ≥56px，active 按压反馈。
 */

import { ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function MobileList<T>({
  items,
  renderItem,
  keyOf,
  loading,
  empty,
  className,
}: {
  items: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  keyOf: (item: T) => string
  loading?: boolean
  empty?: React.ReactNode
  className?: string
}) {
  if (loading && items.length === 0) {
    return (
      <div className="divide-y rounded-lg border bg-card">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-4">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (items.length === 0 && empty) return <>{empty}</>
  return <div className={cn('divide-y rounded-lg border bg-card', className)}>{items.map((it, i) => renderItem(it, i))}</div>
}

export function MobileListItem({
  avatar,
  title,
  subtitle,
  status,
  right,
  onClick,
  danger,
  className,
}: {
  avatar?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** MobileStatusChip */
  status?: React.ReactNode
  /** 右箭头/金额/时间等 */
  right?: React.ReactNode
  onClick?: () => void
  danger?: boolean
  className?: string
}) {
  const row = (
    <>
      {avatar && <div className="shrink-0">{avatar}</div>}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm font-medium', danger && 'text-destructive')}>{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {status && <div className="shrink-0">{status}</div>}
      {right ?? (onClick && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />)}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn('flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted/60', className)}
      >
        {row}
      </button>
    )
  }
  return <div className={cn('flex min-h-14 items-center gap-3 px-4 py-3', className)}>{row}</div>
}
