'use client'

/**
 * MobileStatusChip —— 状态徽章（业务状态到 tone 的映射放各页面，本组件只管展示）。
 * 全变量配色，深浅主题均适配。
 */

import { cn } from '@/lib/utils'

export type MobileChipTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

const TONE_CLASS: Record<MobileChipTone, string> = {
  default: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
}

export function MobileStatusChip({ label, tone = 'default' }: { label: string; tone?: MobileChipTone }) {
  return (
    <span className={cn('rounded-md px-2 py-0.5 text-xs whitespace-nowrap', TONE_CLASS[tone])}>
      {label}
    </span>
  )
}
