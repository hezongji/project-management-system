'use client'

/**
 * 帮助中心（应用内帮助页 · 任务 T-20260823-124-h2）
 *
 * 纯静态自包含内容（数据见 src/components/help/help-data.tsx），不依赖后端 API。
 * 布局：左侧分类锚点导航（桌面端 sticky，滚动联动高亮）+ 右侧内容区；
 * 移动端导航折叠为顶部横向滚动条。组件复用现有 shadcn 体系（Card/Badge/Button）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HELP_SECTIONS } from '@/components/help/help-data'
import { BookOpen, LifeBuoy } from 'lucide-react'

export default function HelpPage() {
  const [activeId, setActiveId] = useState(HELP_SECTIONS[0]?.id ?? '')
  const desktopNavRef = useRef<HTMLDivElement>(null)

  /** 点击导航 → 平滑滚动到对应章节 */
  const scrollTo = useCallback((id: string) => {
    setActiveId(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /** 滚动联动：观察各章节进入视口，同步高亮导航 */
  useEffect(() => {
    const sections = HELP_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => !!el,
    )
    if (sections.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // 取视口内最靠上的章节作为当前章节
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    )
    sections.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  /** 高亮项滚动回导航可视区 */
  useEffect(() => {
    desktopNavRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  return (
    // 通栏布局（2026-08-23 用户要求）：与系统侧边栏共存，(main) 布局已通栏，页面不再限宽
    <div className="w-full px-1 py-4 sm:px-2 lg:px-4">
      {/* ── 页头 ── */}
      <div className="mb-6 flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BookOpen className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">帮助中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按模块快速了解系统的功能与使用方式，内容与线上版本保持同步。没有找到答案时，请联系系统管理员。
          </p>
        </div>
      </div>

      {/* ── 左侧：分类导航（所有屏幕保留，2026-08-23 用户要求；不再用 lg:hidden 隐藏） ── */}
      <div className="flex items-start gap-6">
      <nav className="sticky top-4 w-40 shrink-0 lg:top-20 lg:w-52" aria-label="帮助分类">
          <div ref={desktopNavRef} className="space-y-1 rounded-lg border bg-card p-2">
            {HELP_SECTIONS.map((section) => {
              const active = activeId === section.id
              return (
                <button
                  key={section.id}
                  type="button"
                  data-active={active}
                  onClick={() => scrollTo(section.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <section.icon className="mr-2.5 h-4 w-4 shrink-0" />
                  <span className="truncate">{section.title}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-3 flex items-start gap-1.5 px-3 text-xs leading-relaxed text-muted-foreground">
            <LifeBuoy className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            内容有误或过期？请联系管理员更新帮助内容。
          </p>
        </nav>

        {/* ── 右侧：内容区 ── */}
        <div className="min-w-0 flex-1 space-y-6">
          {HELP_SECTIONS.map((section, sectionIndex) => (
            <Card key={section.id} id={section.id} className="scroll-mt-20">
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <section.icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-lg">
                    <span className="mr-2 text-sm font-semibold text-muted-foreground">
                      {String(sectionIndex + 1).padStart(2, '0')}
                    </span>
                    {section.title}
                  </CardTitle>
                  {section.routes?.map((r) => (
                    <Badge key={r} variant="secondary" className="font-mono text-[11px]">
                      {r}
                    </Badge>
                  ))}
                </div>
                <CardDescription>{section.intro}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {section.items.map((item) => (
                    <li key={item.title} className="flex gap-3">
                      <span
                        aria-hidden
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-6">{item.title}</p>
                        <p className="text-sm leading-relaxed text-muted-foreground">{item.desc}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
