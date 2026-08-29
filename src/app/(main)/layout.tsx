'use client'

/**
 * (main) 登录态布局 —— 依据《开发文档-项目管理系统重构》§2、§8.1
 * 侧边栏（七组导航）+ 顶栏 + AuthGuard（未登录 → /login）
 */

import { AuthGuard } from '@/components/layout/auth-guard'
import { Sidebar, Header } from '@/components/layout/sidebar'
import { AssistantPanel } from '@/components/ai/assistant-panel'
import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import { GlobalConfirmProvider } from '@/lib/global-confirm'

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  return (
    <AuthGuard>
      <GlobalConfirmProvider />
      <div className="min-h-screen w-full bg-background">
        <Sidebar />
        <div className={cn('flex min-h-screen flex-col transition-all', sidebarOpen ? 'lg:pl-60' : 'lg:pl-16')}>
          <Header />
          {/* 通栏布局：内容占满可用宽度（去掉 container 1280/1400 限宽），
              各页面内部用自适应网格（xl/2xl 更多列）与详情页 max-w 控制阅读宽度；
              移动端 px-3 起步，保证 H5 无横向溢出 */}
          <main className="w-full flex-1 overflow-x-clip px-3 py-6 sm:px-4 lg:px-6">
            {children}
          </main>
        </div>
        <AssistantPanel />
      </div>
    </AuthGuard>
  )
}
