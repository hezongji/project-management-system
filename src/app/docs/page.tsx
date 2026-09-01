/**
 * /docs 文档站首页（P2-1）
 *
 * 概览页：栏目卡片网格 + 快速入口，点击进入各栏目。
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import { DOCS_GROUPS, DOCS_SECTIONS, type DocsSection } from '@/components/docs/docs-data'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '帮助文档',
  description: '项目管理系统使用与部署指南：项目管理、任务看板、采购、费用、网盘、IM、Android App、MCP 集成。',
}

function SectionCard({ section }: { section: DocsSection }) {
  const Icon = section.icon
  return (
    <Link
      href={`/docs/${section.slug}`}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        {section.badge && <Badge variant="secondary">{section.badge}</Badge>}
      </div>
      <div>
        <p className="font-semibold text-foreground group-hover:text-primary">{section.title}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{section.description}</p>
      </div>
    </Link>
  )
}

export default function DocsIndexPage() {
  return (
    <div className="space-y-10">
      {/* 页头 */}
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <BookOpen className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">帮助文档</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              项目管理系统 · 使用与部署指南
            </p>
          </div>
        </div>
        <p className="max-w-2xl text-foreground/80">
          从功能概览到快速上手，从一键部署到 MCP 集成，这里覆盖系统的方方面面。
          点击任意栏目进入详情。
        </p>
      </header>

      {/* 分组卡片 */}
      {DOCS_GROUPS.map((group) => {
        const sections = DOCS_SECTIONS.filter((s) => s.group === group.slug)
        if (sections.length === 0) return null
        return (
          <section key={group.slug}>
            <h2 className="mb-4 text-lg font-semibold tracking-tight">{group.label}</h2>
            <div
              className={
                group.slug === 'features'
                  ? 'grid gap-4 sm:grid-cols-2'
                  : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3'
              }
            >
              {sections.map((s) => (
                <SectionCard key={s.slug} section={s} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
