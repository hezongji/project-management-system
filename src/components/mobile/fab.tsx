'use client'

/**
 * MobileFab —— 浮动操作按钮（新建项目/新建任务等）。
 * fixed bottom-20 避开底部 Tab 栏；仅移动端显示（lg:hidden）。
 */

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function MobileFab({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: LucideIcon
  label?: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label ?? '操作'}
      onClick={onClick}
      className={cn(
        'btn-gradient fixed bottom-20 right-4 z-40 flex h-12 items-center justify-center rounded-full text-primary-foreground shadow-lg',
        label ? 'gap-1.5 px-4 text-sm font-medium' : 'w-12 p-0',
        className,
      )}
    >
      <Icon className="h-5 w-5" />
      {label && <span>{label}</span>}
    </button>
  )
}
