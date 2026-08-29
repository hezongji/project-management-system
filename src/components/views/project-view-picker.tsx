'use client'

/**
 * ProjectViewPicker —— P3「多维视图」统一视图契约的地基组件（本任务交付）
 *
 * 依据《开发文档-项目管理系统重构》§8.2⑤、§8.3：
 *   - 顶部横向：项目下拉选择器 + 视图 tabs（甘特/流程/表格/图表）
 *   - 五视图统一读 URL 参数 ?projectId=<项目id>（Next.js useSearchParams）
 *   - 项目下拉数据源：GET /api/projects?page=1&limit=100 → data.items（含 id/code/name）
 *   - 选中项目后 router.replace(`/views/${当前视图}?projectId=${id}`)
 *   - tabs 切换保留 projectId（href 带 ?projectId=）
 *   - 无 projectId 时显示「请选择项目」引导，tabs 仍可用
 *
 * ⚠️ 使用约定（P3-1~4 各视图页面必须遵守）：
 *   1. 组件内部调用 useSearchParams，页面须用 <Suspense> 包裹（Next.js App Router
 *      静态预渲染约束），否则 `next build` 会报
 *      "useSearchParams() should be wrapped in a suspense boundary"。
 *   2. 数据查询统一走 React Query（§8.3），queryKey 规范见下方 VIEW_TABS 相关注释。
 *   3. 组件仅负责「选项目 + 切视图」，不渲染具体视图内容；各视图页面在本组件下方渲染自己的视图。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/services/api'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FolderKanban } from 'lucide-react'

// ───────────────────────────── 契约常量 ─────────────────────────────

/** 视图 tabs（§8.2⑤）：key 与路由 /views/:key 一一对应，label 为中文展示名 */
export const VIEW_TABS = [
  { key: 'gantt', label: '甘特图' },
  { key: 'flow', label: '流程图' },
  { key: 'table', label: '表格视图' },
  { key: 'charts', label: '图表视图' },
] as const

export type ViewKey = (typeof VIEW_TABS)[number]['key']

/** 项目下拉选项（来自 GET /api/projects 的 data.items 子集） */
export interface ProjectOption {
  id: string
  code: string
  name: string
}

// ───────────────────────────── 组件 ─────────────────────────────

export function ProjectViewPicker() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const projectId = searchParams.get('projectId') ?? ''

  // 从 pathname 推导当前视图 key（/views/gantt → 'gantt'），非视图路由兜底为 gantt
  const currentView: ViewKey = (() => {
    const seg = pathname.split('/').filter(Boolean).pop() ?? ''
    const found = VIEW_TABS.find((t) => t.key === seg)
    return found ? found.key : 'gantt'
  })()

  // 项目下拉数据源（§8.3 服务端状态走 React Query；page=1&limit=100 取全量可选项目）
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects', 'view-picker'],
    queryFn: async (): Promise<ProjectOption[]> => {
      const res = await api.get('/projects', { params: { page: 1, limit: 100 } })
      const body = res.data as { data?: { items?: ProjectOption[] } }
      return body?.data?.items ?? []
    },
  })

  const selected = projects.find((p) => p.id === projectId)

  // 切换项目：保留当前视图，替换 URL 的 projectId（§8.2⑤ 五视图同项目切换一致）
  const handleProjectChange = (id: string) => {
    router.replace(`/views/${currentView}?projectId=${encodeURIComponent(id)}`)
  }

  return (
    <div className="space-y-3">
      {/* 统一页头：视图名 + 描述（P3 五视图共用，保证视觉一致） */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {VIEW_TABS.find((t) => t.key === currentView)?.label ?? '多维视图'}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          多维视图 · 同一项目四种视角（甘特 / 流程 / 表格 / 图表）
        </p>
      </div>

      {/* 顶部横向：项目选择器 + 引导 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FolderKanban className="h-4 w-4" />
          <span className="hidden sm:inline">项目</span>
        </div>
        <Select value={projectId || undefined} onValueChange={handleProjectChange}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder={isLoading ? '加载项目…' : '选择项目'} />
          </SelectTrigger>
          <SelectContent>
            {projects.length === 0 && !isLoading && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                暂无可见项目，请联系项目经理将你加入项目
              </div>
            )}
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                <span className="mx-2 text-muted-foreground">·</span>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 无 projectId 引导：tabs 仍可用 */}
        {!projectId && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            请选择项目
            {selected && <span className="font-medium">{selected.name}</span>}
          </span>
        )}
        {projectId && selected && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            当前项目
            <span className="font-medium text-foreground">{selected.name}</span>
          </span>
        )}
      </div>

      {/* 五视图 tabs（§8.2⑤）：切换保留 projectId */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border">
        {VIEW_TABS.map((tab) => {
          const active = tab.key === currentView
          const href = `/views/${tab.key}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
          return (
            <Link
              key={tab.key}
              href={href}
              className={cn(
                'relative -mb-px inline-flex items-center border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
