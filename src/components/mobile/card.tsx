'use client'

/**
 * MobileCard —— 移动端信息卡（统计/概览/详情块）。
 * 可选 title 头部行（标题 + 右侧动作槽）。
 */

import { cn } from '@/lib/utils'

export function MobileCard({
  title,
  extra,
  children,
  className,
  bodyClassName,
}: {
  /** 头部标题（可空 = 无头部行） */
  title?: React.ReactNode
  /** 头部右侧动作槽（"全部"链接等） */
  extra?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      {(title || extra) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <div className="text-sm font-semibold">{title}</div>}
          {extra && <div className="shrink-0 text-xs text-primary">{extra}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  )
}
