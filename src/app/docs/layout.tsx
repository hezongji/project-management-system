/**
 * /docs 文档站布局（P2-1，对标 Kaneo docs）
 *
 * 公开路由（无需登录），侧边栏 + 内容区布局。
 * DocsNav 为客户端组件（当前项高亮 + 移动端抽屉），内容由各页面的服务端组件渲染。
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { DocsNav } from '@/components/docs/docs-nav'

export const metadata: Metadata = {
  title: {
    default: '帮助文档',
    template: '%s · 帮助文档',
  },
  description: '项目管理系统使用与部署指南：项目管理、任务看板、采购、费用、网盘、IM、Android App、MCP 集成。',
  keywords: ['项目管理', '帮助文档', '任务看板', '部署', 'MCP', '企业微信', '钉钉'],
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh w-full bg-background">
      <div className="mx-auto flex w-full max-w-6xl">
        <DocsNav />
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:py-10">
          <div className="mx-auto max-w-3xl">{children}</div>
          <footer className="mx-auto mt-12 flex max-w-3xl items-center justify-between border-t pt-6 text-sm text-muted-foreground">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              返回系统
            </Link>
            <span className="text-xs">
              完整部署文档见仓库 docs/deployment.md
            </span>
          </footer>
        </main>
      </div>
    </div>
  )
}
