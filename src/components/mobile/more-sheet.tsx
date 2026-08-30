'use client'

/**
 * MobileMoreSheet —— "我的"底部抽屉（第 4 个 Tab 展开）。
 * 三段：用户条 / 导航网格（复用 NAV_GROUPS + 权限过滤）/ 底部操作（主题+退出+App下载）。
 */

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { LogOut, Smartphone } from 'lucide-react'
import Link from 'next/link'
import { Sheet } from '@/components/ui/sheet'
import { NAV_GROUPS } from '@/components/layout/sidebar'
import { useAuthStore } from '@/store/auth'
import { getInitials } from '@/lib/utils'
import { cn } from '@/lib/utils'

const THEMES: Array<{ value: string; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'warm', label: '暖阳' },
  { value: 'mist', label: '晴蓝' },
  { value: 'mint', label: '薄荷' },
  { value: 'dark', label: '深色' },
  { value: 'dusk', label: '柔夜' },
]

/** 底部 Tab 已占的入口（工作台/项目列表），抽屉里不再重复 */
const EXCLUDED_HREFS = new Set(['/', '/projects'])

export function MobileMoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const { user, logout } = useAuthStore()
  const { theme, setTheme } = useTheme()

  const isAdmin = user?.role === 'ADMIN'
  const pages = user?.pages

  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin)
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (item) =>
          !EXCLUDED_HREFS.has(item.href) &&
          (!item.pageKey || !pages || pages.includes(item.pageKey) || isAdmin),
      ),
    }))
    .filter((g) => g.items.length > 0)

  const handleLogout = () => {
    onClose()
    logout()
    localStorage.removeItem('auth-token')
    router.replace('/login')
  }

  return (
    <Sheet open={open} onClose={onClose} title="我的" maxHeight="82dvh">
      {/* 用户条 */}
      <div className="mb-4 flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {getInitials(user?.name || user?.email || '?')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{user?.name || user?.email || '未登录'}</div>
          <div className="truncate text-xs text-muted-foreground">
            {user?.role === 'ADMIN' ? '管理员' : user?.role === 'MANAGER' || user?.role === 'PROJECT_MANAGER' ? '项目经理' : '成员'}
            {user?.department?.name ? ` · ${user.department.name}` : ''}
          </div>
        </div>
      </div>

      {/* 导航网格 */}
      <div className="space-y-4">
        {groups.map((g, gi) => (
          <div key={g.label ?? `g-${gi}`}>
            {g.label && <div className="mb-1.5 px-1 text-xs text-muted-foreground">{g.label}</div>}
            <div className="grid grid-cols-2 gap-2">
              {g.items.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className="flex min-h-16 flex-col items-start justify-center gap-1 rounded-lg border border-border bg-background/60 px-3 active:bg-muted/60"
                  >
                    <Icon className="h-5 w-5 text-primary" />
                    <span className="text-sm">{item.name}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 主题切换 */}
      <div className="mt-5">
        <div className="mb-1.5 px-1 text-xs text-muted-foreground">主题</div>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => {
            const active = (theme || 'light') === t.value
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTheme(t.value)}
                className={cn(
                  'min-h-11 rounded-full border px-3.5 text-sm',
                  active
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border text-muted-foreground',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 底部操作 */}
      <div className="mt-5 space-y-2 pb-2">
        <Link
          href="/download"
          onClick={onClose}
          className="flex min-h-11 items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 text-sm font-medium text-primary"
        >
          <Smartphone className="h-4 w-4" />
          手机聊天 App 下载
        </Link>
        <button
          type="button"
          onClick={handleLogout}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm text-destructive active:bg-destructive/10"
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </button>
      </div>
    </Sheet>
  )
}
