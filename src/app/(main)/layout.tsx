'use client'

/**
 * (main) 登录态布局 —— 依据《开发文档-项目管理系统重构》§2、§8.1
 * 侧边栏（七组导航）+ 顶栏 + AuthGuard（未登录 → /login）
 *
 * 双形态布局（sdlc:20260830-mobile-ui W1）：
 * - 桌面（≥1024px）：Sidebar + Header，现状不动
 * - 移动（<1024px）：底部 4 Tab（首页/项目/待办/我的抽屉）+ main pb-16 让位
 * - /im 路由守卫：IM 有自己的四 Tab 壳，主布局不渲染 MobileTabBar 且不加 pb-16（防双 Tab）
 */

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { CheckSquare, FolderKanban, LayoutDashboard, UserRound } from 'lucide-react'
import { AuthGuard } from '@/components/layout/auth-guard'
import { Sidebar, Header } from '@/components/layout/sidebar'
import { AssistantPanel } from '@/components/ai/assistant-panel'
import { MobileTabBar, MobileMoreSheet, type MobileTabBarItem } from '@/components/mobile'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import { GlobalConfirmProvider } from '@/lib/global-confirm'

/** 底部 4 Tab：首页/项目/待办/我的（无 href = onAction 开抽屉） */
const MAIN_TABS: MobileTabBarItem[] = [
  { key: 'home', label: '首页', icon: LayoutDashboard, href: '/' },
  { key: 'projects', label: '项目', icon: FolderKanban, href: '/projects' },
  { key: 'todos', label: '待办', icon: CheckSquare, href: '/todos' },
  { key: 'more', label: '我的', icon: UserRound },
]

/** pathname → 激活 Tab key（其余路由一律 more） */
function tabKeyOf(pathname: string): string {
  if (pathname === '/') return 'home'
  if (pathname.startsWith('/projects')) return 'projects'
  if (pathname.startsWith('/todos')) return 'todos'
  return 'more'
}

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const pathname = usePathname()
  const isMobile = useIsMobile()
  // /im 守卫：IM 独立 App 壳有自己的四 Tab，主布局移动端组件不介入
  const isImRoute = pathname.startsWith('/im')
  const [moreOpen, setMoreOpen] = useState(false)
  const showMobileTab = isMobile && !isImRoute

  return (
    <AuthGuard>
      <GlobalConfirmProvider />
      <div className="min-h-screen w-full">
        <Sidebar />
        <div className={cn('flex min-h-screen flex-col transition-all', sidebarOpen ? 'lg:pl-60' : 'lg:pl-16')}>
          <Header />
          {/* 通栏布局：内容占满可用宽度（去掉 container 1280/1400 限宽），
              各页面内部用自适应网格（xl/2xl 更多列）与详情页 max-w 控制阅读宽度；
              移动端 px-3 起步，保证 H5 无横向溢出。
              移动端 pb-16 给底部 Tab 让位（/im 除外，IM 自带 Tab 布局） */}
          <main
            className={cn(
              'w-full flex-1 overflow-x-clip px-3 py-6 sm:px-4 lg:px-6',
              showMobileTab && 'pb-16',
            )}
          >
            {children}
          </main>
        </div>
        <AssistantPanel />
        {/* 移动端底部 Tab + "我的"抽屉（桌面不渲染；/im 不渲染防双 Tab）。
            MobileTabBar 自带 fixed + lg:hidden（CSS 双保险） */}
        {showMobileTab && (
          <MobileTabBar
            items={MAIN_TABS}
            activeKey={tabKeyOf(pathname)}
            onAction={(k) => k === 'more' && setMoreOpen(true)}
          />
        )}
        <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
      </div>
    </AuthGuard>
  )
}
