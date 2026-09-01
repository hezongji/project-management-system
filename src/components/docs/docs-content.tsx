/**
 * 文档内容块渲染器（P2-1）
 *
 * 纯服务端组件：把 docs-data 的结构化块渲染为 JSX。
 * 支持轻量内联强调：`行内代码` 与 **粗体**（不引入 markdown 依赖）。
 */

import type { ReactNode } from 'react'
import { AlertTriangle, Info, Lightbulb } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DocsBlock, DocsSection, CalloutVariant } from './docs-data'

/** 内联文本 → ReactNode（支持 `code` 与 **bold**） */
function renderInline(text: string): ReactNode[] {
  // 匹配 `code` 或 **bold**（不跨行）
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      parts.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const CALLOUT_STYLES: Record<CalloutVariant, { icon: typeof Info; className: string }> = {
  info: {
    icon: Info,
    className: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100',
  },
  tip: {
    icon: Lightbulb,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
  },
  warn: {
    icon: AlertTriangle,
    className:
      'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
  },
}

/** 单块渲染 */
function Block({ block }: { block: DocsBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="leading-7 text-foreground/90">{renderInline(block.text)}</p>
    case 'h2':
      return (
        <h2 className="mt-10 border-b pb-2 text-xl font-semibold tracking-tight first:mt-0">
          {block.text}
        </h2>
      )
    case 'h3':
      return <h3 className="mt-6 text-base font-semibold tracking-tight">{block.text}</h3>
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      return (
        <ListTag
          className={cn(
            'space-y-1.5 pl-5',
            block.ordered ? 'list-decimal' : 'list-disc',
            'marker:text-muted-foreground',
          )}
        >
          {block.items.map((it, i) => (
            <li key={i} className="leading-7 text-foreground/90">
              {renderInline(it)}
            </li>
          ))}
        </ListTag>
      )
    }
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border bg-muted/60 p-4 text-sm leading-relaxed">
          <code className="font-mono text-foreground/90">{block.code}</code>
        </pre>
      )
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/60">
                {block.headers.map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-b last:border-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-foreground/90">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'callout': {
      const v = block.variant ?? 'info'
      const style = CALLOUT_STYLES[v]
      const Icon = style.icon
      return (
        <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', style.className)}>
          <Icon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {block.title && <p className="font-semibold">{block.title}</p>}
            <p className="leading-6 opacity-90">{renderInline(block.text)}</p>
          </div>
        </div>
      )
    }
    default:
      return null
  }
}

/** 栏目标题区（slug + 标题 + 描述） */
export function DocsSectionHeader({ section }: { section: DocsSection }) {
  const Icon = section.icon
  return (
    <header className="mb-8 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{section.title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{section.description}</p>
        </div>
      </div>
    </header>
  )
}

/** 渲染栏目全部内容块 */
export function DocsContent({ section }: { section: DocsSection }) {
  return (
    <div className="space-y-4">
      <DocsSectionHeader section={section} />
      {section.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}
