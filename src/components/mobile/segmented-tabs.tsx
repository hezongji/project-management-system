'use client'

/**
 * MobileSegmentedTabs —— 移动端分段 Tab（替代桌面 Tabs）。
 * >4 个 tab 自动横向滚动（隐藏滚动条）；项触控 ≥44px。
 */

import { cn } from '@/lib/utils'

export interface MobileSegmentedTab {
  key: string
  label: string
  count?: number
}

export function MobileSegmentedTabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: MobileSegmentedTab[]
  active: string
  onChange: (k: string) => void
  className?: string
}) {
  return (
    <div
      className={cn('flex overflow-x-auto border-b bg-card', className)}
      style={{ scrollbarWidth: 'none' }}
    >
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'relative flex min-h-11 flex-1 items-center justify-center gap-1 whitespace-nowrap px-3 text-sm',
              isActive
                ? 'border-b-2 border-primary font-medium text-primary'
                : 'text-muted-foreground',
            )}
          >
            <span>{t.label}</span>
            {t.count != null && (
              <span
                className={cn(
                  'ml-0.5 rounded-full px-1.5 text-[10px] leading-4',
                  t.count > 0 && !isActive
                    ? 'bg-red-500 text-white'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {t.count > 99 ? '99+' : t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
