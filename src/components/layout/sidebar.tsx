'use client'

/**
 * 新侧边栏布局（P0-3）—— 依据《开发文档-项目管理系统重构》§8.1、附录 A
 *
 * 七组导航：项目 / 组织架构 / 文件 / 视图 / IM / 待办 / 管理（+顶部工作台）
 *  - 消息：角标接 chat store 的 unreadTotal（P4-3 实时未读）；待办：todoCount 接 notification store 的 todoUnread（P5 已接，免打扰开启时静默）
 *  - 管理（系统管理）：仅 ADMIN 可见
 *  - 组织架构 / 文件 / 视图(甘特·流程·表格·图表) / IM / 待办：占位页，由 P0-4 / P2 / P3 / P4 交付
 * 风格沿用现有 Radix + tailwind 组件体系（Button/Badge/cn）。
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { api } from '@/services/api-instance'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuthStore } from '@/store/auth'
import { useAppStore } from '@/store/app'
import { useChatStore } from '@/store/chat'
import { NotificationBell } from '@/components/layout/notification-bell'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  LayoutDashboard,
  FolderKanban,
  CheckSquare,
  Workflow,
  BarChart3,
  Network,
  FolderOpen,
  ShoppingCart,
  MessageSquare,
  Settings,
  Search,
  Menu,
  X,
  LogOut,
  User as UserIcon,
  Palette,
  Minus,
  Maximize2,
  Minimize2,
  Building2,
  Briefcase,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  HelpCircle,
} from 'lucide-react'
import { useTheme } from 'next-themes'

// ───────────────────────────── 导航定义（§8.1） ─────────────────────────────

interface NavItem {
  name: string
  href: string
  icon: typeof FolderKanban
  badge?: 'unread' | 'todo' // 角标来源（占位，后续阶段接真实数据）
  exact?: boolean // 精确匹配（不匹配子路径，用于父级入口）
  pageKey?: string // 权限 V2：页面权限 key（为空 = 不参与页面权限控制）
}

interface NavGroup {
  label: string | null // null = 无分组标题的独立入口（工作台）
  items: NavItem[]
  adminOnly?: boolean
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ name: '工作台', href: '/', icon: LayoutDashboard, pageKey: 'dashboard' }],
  },
  {
    label: '项目',
    items: [
      { name: '项目列表', href: '/projects', icon: FolderKanban, pageKey: 'projects' },
      { name: '项目任务', href: '/tasks', icon: CheckSquare, pageKey: 'tasks' },
      { name: '流程模板', href: '/process-templates', icon: Workflow, pageKey: 'process-templates' },
      { name: '统计图表', href: '/views/charts', icon: BarChart3, pageKey: 'charts' },
    ],
  },
  {
    label: '采购',
    items: [{ name: '采购订单', href: '/purchase', icon: ShoppingCart, pageKey: 'purchase' }],
  },
  {
    label: '文件',
    items: [{ name: '文件目录', href: '/files', icon: FolderOpen, pageKey: 'files' }],
  },
  {
    label: 'IM',
    items: [{ name: '消息', href: '/messages', icon: MessageSquare, badge: 'unread', pageKey: 'messages' }],
  },
  {
    label: '管理',
    adminOnly: true,
    items: [
      { name: '组织架构', href: '/organization', icon: Network, exact: true, pageKey: 'organization' },
      { name: '外部主体', href: '/organization/externals', icon: Building2, pageKey: 'externals' },
      { name: '岗位字典', href: '/organization/job-titles', icon: Briefcase, pageKey: 'job-titles' },
      { name: '系统管理', href: '/settings', icon: Settings, pageKey: 'settings' },
    ],
  },
  {
    label: null,
    items: [{ name: '帮助中心', href: '/help', icon: HelpCircle }], // 无 pageKey：不参与页面权限控制，全员可见
  },
]

/** 旧路由 → 新路由 301 重定向映射（配置在 next.config.js，此处仅作对照文档） */
export const LEGACY_REDIRECTS: { from: string; to: string; note: string }[] = [
  { from: '/dashboard', to: '/', note: '工作台迁移到根路由 (main)/page.tsx' },
  { from: '/teams', to: '/organization', note: '团队页由组织架构内部树替代（P0-4）' },
  { from: '/org', to: '/organization', note: 'P0-4 占位路由转正' },
  { from: '/gantt', to: '/views/gantt', note: '甘特图归入视图组' },
  { from: '/debug', to: '/', note: '调试页删除（附录 A）' },
]

// ───────────────────────────── Sidebar ─────────────────────────────

interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const pathname = usePathname()
  const { user, logout } = useAuthStore()
  const { sidebarOpen, setSidebarOpen, mobileMenuOpen, setMobileMenuOpen } = useAppStore()
  const unreadTotal = useChatStore((s) => s.unreadTotal)
  const { theme, setTheme } = useTheme()
  const router = useRouter()
  // 分组折叠持久化（2026-08-22 UIUX P2 修复：localStorage 记忆用户偏好）
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      return JSON.parse(localStorage.getItem('pm-sidebar-collapsed') ?? '{}')
    } catch {
      return {}
    }
  })
  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((s) => {
      const next = { ...s, [groupKey]: !s[groupKey] }
      try {
        localStorage.setItem('pm-sidebar-collapsed', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const isAdmin = user?.role === 'ADMIN'
  const pages = user?.pages

  const isActive = (href: string, exact = false) =>
    href === '/'
      ? pathname === '/'
      : exact
        ? pathname === href
        : pathname === href || pathname.startsWith(href + '/')

  const handleLogout = () => {
    logout()
    localStorage.removeItem('auth-token')
    router.replace('/login')
  }

  const renderNav = (mobile: boolean, sbCollapsed: boolean) => (
    <nav className={cn('flex-1 overflow-y-auto py-4', sbCollapsed ? 'space-y-2 px-2' : 'space-y-4 px-3')}>
      {NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin)
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) =>
              !item.pageKey ||
              !pages ||
              pages.includes(item.pageKey) ||
              isAdmin,
          ),
        }))
        .filter((group) => group.items.length > 0)
        .map((group, gi) => {
        const groupKey = group.label ?? `top-${gi}`
        const collapsed = collapsedGroups[groupKey]
        return (
          <div key={groupKey}>
            {group.label && !sbCollapsed && (
              <button
                type="button"
                onClick={() =>
                  !mobile && toggleGroup(groupKey)
                }
                className="mb-1 flex w-full items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {group.label}
                {!mobile && (
                  <ChevronDown
                    className={cn('h-4 w-4 text-muted-foreground transition-transform', collapsed && '-rotate-90')}
                  />
                )}
              </button>
            )}
            {group.label && sbCollapsed && <div className="mb-2 border-t pt-2" />}
            <div className={cn('space-y-1', collapsed && 'hidden')}>
              {group.items.map((item) => {
                const active = isActive(item.href, item.exact)
                const badgeCount = item.badge === 'unread' ? unreadTotal : 0
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'group flex items-center rounded-md py-2 text-sm font-medium',
                      sbCollapsed ? 'justify-center px-0' : 'justify-between px-3',
                      active
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                    onClick={() => mobile && setMobileMenuOpen(false)}
                    title={sbCollapsed ? item.name : undefined}
                  >
                    <span className="flex items-center">
                      <item.icon className={cn('h-5 w-5 shrink-0', !sbCollapsed && 'mr-3')} />
                      {!sbCollapsed && item.name}
                    </span>
                    {!sbCollapsed && (
                      <span className="flex items-center gap-1">
                        {badgeCount > 0 && (
                          <Badge className="h-5 min-w-[20px] rounded-full px-1 text-[10px] leading-none">
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </Badge>
                        )}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )

  const sidebarInner = (mobile: boolean, sbCollapsed: boolean) => (
    <>
      <div className="flex h-16 items-center gap-2 border-b px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Building2 className="h-4 w-4" />
        </div>
        {!sbCollapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">项目管理系统</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">示例装备</p>
          </div>
        )}
        {!mobile && !sbCollapsed && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setSidebarOpen(false)}
            title="收起侧边栏"
          >
            <ChevronsLeft className="h-5 w-5" />
          </Button>
        )}
        {!mobile && sbCollapsed && (
          <Button
            variant="ghost"
            size="sm"
            className="mx-auto shrink-0"
            onClick={() => setSidebarOpen(true)}
            title="展开侧边栏"
          >
            <ChevronsRight className="h-5 w-5" />
          </Button>
        )}
        {mobile && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMobileMenuOpen(false)}>
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>
      {renderNav(mobile, sbCollapsed)}
      <div className="border-t p-3">
        <div className={cn('flex items-center', sbCollapsed ? 'flex-col gap-1' : 'justify-between')}>
          <Select value={theme || 'light'} onValueChange={setTheme}>
            <SelectTrigger
              title="切换主题"
              className={cn(
                'h-8 border-0 bg-transparent text-muted-foreground hover:text-foreground focus:ring-0',
                sbCollapsed ? 'w-8 justify-center px-0' : 'w-auto gap-1.5 px-1.5'
              )}
            >
              <Palette className="h-4 w-4 shrink-0" />
              {!sbCollapsed && <SelectValue />}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">浅色</SelectItem>
              <SelectItem value="warm">暖阳</SelectItem>
              <SelectItem value="mist">雾蓝</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="dusk">柔夜</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={handleLogout} title="退出登录" className={cn(sbCollapsed && 'w-full')}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  )

  return (
    <>
      {/* Mobile sidebar */}
      <div className={cn('fixed inset-0 z-50 lg:hidden', mobileMenuOpen ? 'block' : 'hidden')}>
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75" onClick={() => setMobileMenuOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-[85%] max-w-xs flex-col bg-card shadow-xl">
          {sidebarInner(true, false)}
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden flex-col border-r bg-card lg:flex',
          sidebarOpen ? 'w-60' : 'w-16',
          className
        )}
      >
        {sidebarInner(false, !sidebarOpen)}
      </aside>
    </>
  )
}

// ───────────────────────────── Header（§8.1 顶栏） ─────────────────────────────

interface HeaderProps {
  className?: string
}

/** /api/search 分组结果（P2-2） */
interface SearchResults {
  projects: { id: string; code: string; name: string; isArchived?: boolean }[]
  tasks: { id: string; title: string; projectId: string; project?: { code: string } }[]
  users: { id: string; name: string | null; email: string; avatar?: string | null }[]
}

export function Header({ className }: HeaderProps) {
  const { setSidebarOpen, setMobileMenuOpen } = useAppStore()
  const { user, logout } = useAuthStore()
  const router = useRouter()

  // 窗口控制（类桌面应用）：全屏状态 + 最小化/最大化/关闭
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const minimizeWindow = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }
  const toggleMaximize = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }
  const closeApp = () => {
    logout()
    localStorage.removeItem('auth-token')
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    router.replace('/login')
  }

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // 移动端全屏搜索（2026-08-22 UIUX P1 修复）
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const mobileBoxRef = useRef<HTMLDivElement>(null)

  // 移动端搜索面板打开时自动聚焦
  useEffect(() => {
    if (mobileSearchOpen) {
      const t = setTimeout(() => {
        document.querySelector<HTMLInputElement>('#mobile-search-input')?.focus()
      }, 100)
      return () => clearTimeout(t)
    }
  }, [mobileSearchOpen])

  // 防抖 300ms 调 /api/search（§P2-2）
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setOpen(false)
      setLoading(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await api.get('/search', { params: { q } })
        setResults((res.data?.data as SearchResults) ?? null)
        setOpen(true)
      } catch {
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // 点击输入框外关闭下拉
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    setQuery('')
    setResults(null)
    router.push(href)
  }

  const hasResults =
    !!results &&
    (results.projects.length > 0 || results.tasks.length > 0 || results.users.length > 0)

  return (
    <header
      className={cn(
        'sticky top-0 z-30 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60',
        className
      )}
    >
      <div className="flex h-16 items-center gap-4 px-4 lg:px-6">
        <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setMobileMenuOpen(true)}>
          <Menu className="h-5 w-5" />
        </Button>

        {/* 移动端搜索按钮（2026-08-22 UIUX P1 修复） */}
        <Button
          variant="ghost"
          size="sm"
          className="sm:hidden"
          onClick={() => setMobileSearchOpen(true)}
          aria-label="搜索"
        >
          <Search className="h-5 w-5" />
        </Button>

        {/* 全局搜索（项目/任务/成员，P2-2） */}
        <div ref={boxRef} className="relative hidden flex-1 sm:block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目、任务、成员…"
            className="h-9 w-full max-w-md rounded-md border border-input bg-background pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />

          {open && query.trim() && (
            <div className="absolute left-0 top-10 z-50 w-full max-w-md overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
              {loading ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">搜索中…</div>
              ) : !hasResults ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">未找到匹配结果</div>
              ) : (
                <div className="max-h-96 overflow-y-auto py-1">
                  {results!.projects.length > 0 && (
                    <SearchGroup label="项目">
                      {results!.projects.map((p) => (
                        <SearchItem key={p.id} onClick={() => go(`/projects/${p.id}`)}>
                          <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-mono text-xs text-primary">{p.code}</span> {p.name}
                          </span>
                          {p.isArchived && <span className="text-xs text-muted-foreground">已归档</span>}
                        </SearchItem>
                      ))}
                    </SearchGroup>
                  )}
                  {results!.tasks.length > 0 && (
                    <SearchGroup label="任务">
                      {results!.tasks.map((t) => (
                        <SearchItem key={t.id} onClick={() => go('/tasks')}>
                          <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {t.title}
                            {t.project?.code && (
                              <span className="font-mono text-xs text-muted-foreground"> · {t.project.code}</span>
                            )}
                          </span>
                        </SearchItem>
                      ))}
                    </SearchGroup>
                  )}
                  {results!.users.length > 0 && (
                    <SearchGroup label="成员">
                      {results!.users.map((u) => (
                        <SearchItem key={u.id} onClick={() => go('/organization')}>
                          <UserIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {u.name || u.email}
                            <span className="text-xs text-muted-foreground"> · {u.email}</span>
                          </span>
                        </SearchItem>
                      ))}
                    </SearchGroup>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 sm:hidden" />

        <div className="flex items-center space-x-2">
          {/* 通知铃 —— P5 通知中心（§8.3） */}
          <NotificationBell />

          <div className="flex items-center space-x-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <UserIcon className="h-4 w-4" />
            </div>
            <div className="hidden md:block">
              <p className="text-sm font-medium">{user?.name || '未登录'}</p>
              <p className="text-xs text-muted-foreground">{user?.role || ''}</p>
            </div>
          </div>

          {/* 窗口控制（最小化/最大化/关闭）—— 仅桌面端，独立于账号操作 */}
          <div className="hidden items-center gap-0.5 border-l pl-2 sm:flex">
            <button
              type="button"
              onClick={minimizeWindow}
              title="最小化"
              aria-label="最小化"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={toggleMaximize}
              title={isFullscreen ? '还原' : '最大化'}
              aria-label={isFullscreen ? '还原' : '最大化'}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={closeApp}
              title="关闭"
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 移动端全屏搜索面板（2026-08-22 UIUX P1 修复） */}
      <Dialog open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
        <DialogContent className="top-[10%] max-w-md translate-y-0 sm:hidden">
          <DialogHeader>
            <DialogTitle>搜索</DialogTitle>
          </DialogHeader>
          <div ref={mobileBoxRef} className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="mobile-search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索项目、任务、成员…"
              className="h-10 w-full rounded-md border border-input bg-background pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />

            {open && query.trim() && (
              <div className="mt-2 max-h-[50vh] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg">
                {loading ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">搜索中…</div>
                ) : !hasResults ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">未找到匹配结果</div>
                ) : (
                  <div className="py-1">
                    {results!.projects.length > 0 && (
                      <SearchGroup label="项目">
                        {results!.projects.map((p) => (
                          <SearchItem
                            key={p.id}
                            onClick={() => {
                              go(`/projects/${p.id}`)
                              setMobileSearchOpen(false)
                            }}
                          >
                            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-mono text-xs text-primary">{p.code}</span> {p.name}
                            </span>
                          </SearchItem>
                        ))}
                      </SearchGroup>
                    )}
                    {results!.tasks.length > 0 && (
                      <SearchGroup label="任务">
                        {results!.tasks.map((t) => (
                          <SearchItem
                            key={t.id}
                            onClick={() => {
                              go('/tasks')
                              setMobileSearchOpen(false)
                            }}
                          >
                            <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              {t.title}
                              {t.project?.code && (
                                <span className="font-mono text-xs text-muted-foreground"> · {t.project.code}</span>
                              )}
                            </span>
                          </SearchItem>
                        ))}
                      </SearchGroup>
                    )}
                    {results!.users.length > 0 && (
                      <SearchGroup label="成员">
                        {results!.users.map((u) => (
                          <SearchItem
                            key={u.id}
                            onClick={() => {
                              go('/organization')
                              setMobileSearchOpen(false)
                            }}
                          >
                            <UserIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              {u.name || u.email}
                              <span className="text-xs text-muted-foreground"> · {u.email}</span>
                            </span>
                          </SearchItem>
                        ))}
                      </SearchGroup>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}

function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  )
}

function SearchItem({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
    >
      {children}
    </button>
  )
}
