'use client'

/**
 * MobileEmptyState —— 空态占位（图标 + 文案 + 可选动作）。
 */

import type { LucideIcon } from 'lucide-react'

export function MobileEmptyState({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon: LucideIcon
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-8 py-16 text-center">
      <Icon className="h-10 w-10 text-muted-foreground/50" />
      <div className="text-sm font-medium text-foreground">{title}</div>
      {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
