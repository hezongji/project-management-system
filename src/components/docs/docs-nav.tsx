'use client'

/**
 * 文档站侧边导航（P2-1）
 *
 * 客户端组件：负责当前栏目高亮（usePathname）与移动端抽屉。
 * - 桌面端：左侧 sticky 分组导航
 * - 移动端：顶部栏 + 底部抽屉（Sheet）
 * 纯导航，不参与内容渲染。
 */

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BookOpen, Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sheet } from '@/components/ui/sheet'
import { DOCS_GROUPS, DOCS_SECTIONS, type DocsSection } from './docs-data'

/** 分组导航列表（桌面 / 抽屉共用） */
function NavList({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-6 px-3">
      {DOCS_GROUPS.map((group) => {
        const sections = DOCS_SECTIONS.filter((s) => s.group === group.slug)
        if (sections.length === 0) return null
        return (
          <div key={group.slug}>
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {sections.map((s) => (
                <NavItem
                  key={s.slug}
                  section={s}
                  active={s.slug === current}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function NavItem({
  section,
  active,
  onNavigate,
}: {
  section: DocsSection
  active: boolean
  onNavigate?: () => void
}) {
  const Icon = section.icon
  return (
    <li>
      <Link
        href={`/docs/${section.slug}`}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
          active
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-foreground/80 hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{section.title}</span>
      </Link>
    </li>
  )
}

export function DocsNav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  // /docs/<slug> → slug；/docs 首页 → ''
  const current = pathname.replace(/^\/docs\/?/, '').split('/')[0] ?? ''

  return (
    <>
      {/* 移动端顶部栏 */}
      <div className="sticky top-0 z-40 flex items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur lg:hidden">
        <button
          type="button"
          aria-label="打开文档导航"
          onClick={() => setOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/docs" className="flex items-center gap-2 font-semibold">
          <BookOpen className="h-5 w-5 text-primary" />
          帮助文档
        </Link>
      </div>

      {/* 移动端抽屉 */}
      <Sheet open={open} onClose={() => setOpen(false)} title="帮助文档">
        <div className="overflow-y-auto py-4">
          <Link
            href="/docs"
            onClick={() => setOpen(false)}
            className={cn(
              'mb-4 flex items-center gap-2.5 rounded-md px-6 py-2 text-sm transition-colors',
              current === '' ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80 hover:bg-muted',
            )}
          >
            <BookOpen className="h-4 w-4" />
            文档首页
          </Link>
          <NavList current={current} onNavigate={() => setOpen(false)} />
        </div>
      </Sheet>

      {/* 桌面端侧边栏 */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-y-auto border-r bg-background py-6 lg:block">
        <div className="mb-6 px-3">
          <Link href="/docs" className="flex items-center gap-2.5 px-3 text-lg font-bold tracking-tight">
            <BookOpen className="h-5 w-5 text-primary" />
            帮助文档
          </Link>
          <p className="mt-1 px-3 text-xs text-muted-foreground">项目管理系统使用与部署指南</p>
        </div>
        <NavList current={current} />
      </aside>
    </>
  )
}
