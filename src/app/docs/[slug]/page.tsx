/**
 * /docs/[slug] 栏目详情页（P2-1）
 *
 * 由 docs-data 结构化内容数组驱动，generateStaticParams 预生成全部栏目，
 * generateMetadata 按栏目输出独立 SEO meta。
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DOCS_INDEX, DOCS_SECTIONS } from '@/components/docs/docs-data'
import { DocsContent } from '@/components/docs/docs-content'

type RouteContext = { params: Promise<{ slug: string }> }

/** 预生成全部栏目静态页 */
export function generateStaticParams() {
  return DOCS_SECTIONS.map((s) => ({ slug: s.slug }))
}

/** 按栏目生成 meta */
export async function generateMetadata({ params }: RouteContext): Promise<Metadata> {
  const { slug } = await params
  const section = DOCS_INDEX[slug]
  if (!section) return { title: '未找到' }
  return {
    title: section.title,
    description: section.description,
    alternates: { canonical: `/docs/${slug}` },
  }
}

export default async function DocsSectionPage({ params }: RouteContext) {
  const { slug } = await params
  const section = DOCS_INDEX[slug]
  if (!section) notFound()
  return <DocsContent section={section} />
}
