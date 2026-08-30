'use client'

/**
 * MobileTabBar —— 底部 4 Tab 导航栏（复刻 /im 底部 nav 样式）。
 * 外层 nav 带 data-mobile-tabbar 属性（验收打点）。
 * 仅移动端显示（lg:hidden）；有 href 用 Link，无 href 调 onAction（如"我的"开抽屉）。
 */

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MobileTabBarItem {
  key: string
  label: string
  icon: LucideIcon
  /** 路由；无 href = 本地动作（onAction 处理） */
  href?: string
  /** >0 显示红点角标（99+ 截断） */
  badge?: number
}

export function MobileTabBar({
  items,
  activeKey,
  onAction,
}: {
  items: MobileTabBarItem[]
  activeKey: string
  onAction?: (key: string) => void
}) {
  return (
    <nav
      data-mobile-tabbar
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map((t) => {
        const active = activeKey === t.key
        const Icon = t.icon
        const badge = t.badge ?? 0
        const cls = cn(
          'relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px]',
          active ? 'text-primary' : 'text-muted-foreground',
        )
        const inner = (
          <>
            <span className="relative">
              <Icon className={cn('h-6 w-6', active && 'fill-primary/10')} />
              {badge > 0 && (
                <span className="absolute -right-2.5 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span>{t.label}</span>
          </>
        )
        return t.href ? (
          <Link key={t.key} href={t.href} className={cls} aria-current={active ? 'page' : undefined}>
            {inner}
          </Link>
        ) : (
          <button key={t.key} type="button" onClick={() => onAction?.(t.key)} className={cls}>
            {inner}
          </button>
        )
      })}
    </nav>
  )
}
