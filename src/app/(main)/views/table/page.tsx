'use client'

/**
 * /views/table —— 表格视图（TableView，P3 交付）
 *
 * 依据《开发文档-项目管理系统重构》§8.2⑤：
 *   TableView : TanStack Table 全字段矩阵 + 导出 xlsx（sheetjs）
 *
 * 功能：
 *   1. 全字段矩阵：code/name/order/status(徽章)/owner.name/plannedStart/plannedEnd/
 *      actualEnd/progress(进度条)/taskCount/taskDone/fileStats(approved/total)/delayed(红标)
 *   2. 列排序（order/progress/taskCount）+ 状态筛选（下拉）
 *   3. 导出 xlsx（中文表头，XLSX.utils.json_to_sheet + writeFile）
 *
 * 数据源：GET /api/projects/:id/tree → data.phases[]（§7.4）
 * 视图契约：顶部挂 <ProjectViewPicker />（读 ?projectId=），无 projectId 引导选择。
 * ⚠️ ProjectViewPicker / 本页内容均用 useSearchParams，须 <Suspense> 包裹。
 */

import { Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, Download, FolderKanban, Table2 } from 'lucide-react'

import { ProjectViewPicker } from '@/components/views/project-view-picker'
import { api } from '@/services/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

// ───────────────────────────── 常量 ─────────────────────────────

/** 阶段状态徽章（与 phase-card/phaseId 页口径一致） */
const PHASE_STATUS_META: Record<string, { label: string; cls: string }> = {
  NOT_STARTED: { label: '未开始', cls: 'bg-slate-100 text-slate-600' },
  IN_PROGRESS: { label: '进行中', cls: 'bg-blue-100 text-blue-700' },
  DONE: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700' },
  SKIPPED: { label: '已跳过', cls: 'bg-zinc-200 text-zinc-500' },
  PAUSED: { label: '已暂停', cls: 'bg-amber-100 text-amber-700' },
}

const PHASE_STATUS_OPTIONS = ['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'SKIPPED', 'DONE'] as const

// ───────────────────────────── 类型 ─────────────────────────────

/** 表格行（由 tree.phases 归一化） */
interface PhaseRow {
  id: string
  code: string
  name: string
  order: number
  status: string
  ownerName: string
  plannedStart: string | null
  plannedEnd: string | null
  actualEnd: string | null
  progress: number
  taskCount: number
  taskDone: number
  fileApproved: number
  fileTotal: number
  delayed: boolean
}

/** GET /projects/:id/tree 的 data.phases 子集 */
interface TreePhase {
  id: string
  code: string
  name: string
  order: number
  status: string
  owner?: { id: string; name: string; avatar?: string | null } | null
  plannedStart?: string | null
  plannedEnd?: string | null
  actualEnd?: string | null
  progress?: number
  taskCount?: number
  taskDone?: number
  fileStats?: { total: number; approved: number }
  delayed?: boolean
}

interface TreeBody {
  project?: { code?: string; name?: string }
  phases?: TreePhase[]
}

/** YYYY-MM-DD（无效/空 → '—'） */
function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 导出 xlsx（中文表头，sheetjs） */
function exportToExcel(rows: PhaseRow[], projectCode?: string) {
  const data = rows.map((r) => ({
    '阶段编号': r.code,
    '阶段名称': r.name,
    '顺序': r.order,
    '状态': PHASE_STATUS_META[r.status]?.label ?? r.status,
    '负责人': r.ownerName || '—',
    '计划开始': fmtDate(r.plannedStart),
    '计划结束': fmtDate(r.plannedEnd),
    '实际结束': fmtDate(r.actualEnd),
    '进度(%)': r.progress,
    '任务总数': r.taskCount,
    '任务完成': r.taskDone,
    '文件(通过/总数)': `${r.fileApproved}/${r.fileTotal}`,
    '是否延误': r.delayed ? '是' : '否',
  }))
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '阶段矩阵')
  const name = `${projectCode ? projectCode + '-' : ''}阶段矩阵.xlsx`
  XLSX.writeFile(wb, name)
}

// ───────────────────────────── 表格组件 ─────────────────────────────

function PhaseMatrix({ rows, projectCode }: { rows: PhaseRow[]; projectCode?: string }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [statusFilter, setStatusFilter] = useState<string>('ALL')

  const columns = useMemo<ColumnDef<PhaseRow, any>[]>(
    () => [
      { accessorKey: 'code', header: '阶段编号', enableSorting: false },
      { accessorKey: 'name', header: '阶段名称', enableSorting: false },
      { accessorKey: 'order', header: '顺序' },
      {
        accessorKey: 'status',
        header: '状态',
        enableSorting: false,
        cell: ({ getValue }) => {
          const s = getValue() as string
          const meta = PHASE_STATUS_META[s]
          return (
            <Badge className={cn('whitespace-nowrap', meta?.cls)}>
              {meta?.label ?? s}
            </Badge>
          )
        },
      },
      {
        accessorKey: 'ownerName',
        header: '负责人',
        enableSorting: false,
        cell: ({ getValue }) => {
          const name = getValue() as string
          return <span className="whitespace-nowrap">{name || '—'}</span>
        },
      },
      {
        accessorKey: 'plannedStart',
        header: '计划开始',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-mono text-xs">
            {fmtDate(getValue() as string | null)}
          </span>
        ),
      },
      {
        accessorKey: 'plannedEnd',
        header: '计划结束',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-mono text-xs">
            {fmtDate(getValue() as string | null)}
          </span>
        ),
      },
      {
        accessorKey: 'actualEnd',
        header: '实际结束',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-mono text-xs">
            {fmtDate(getValue() as string | null)}
          </span>
        ),
      },
      {
        accessorKey: 'progress',
        header: '进度',
        cell: ({ getValue }) => {
          const p = getValue() as number
          const pct = Math.min(100, Math.max(0, p ?? 0))
          return (
            <div className="flex items-center gap-2">
              <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">{pct}%</span>
            </div>
          )
        },
      },
      { accessorKey: 'taskCount', header: '任务总数' },
      {
        accessorKey: 'taskDone',
        header: '任务完成',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs">
            {row.original.taskDone}
            <span className="text-muted-foreground">/{row.original.taskCount}</span>
          </span>
        ),
      },
      {
        id: 'files',
        header: '文件(通过/总数)',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs">
            {row.original.fileApproved}
            <span className="text-muted-foreground">/{row.original.fileTotal}</span>
          </span>
        ),
      },
      {
        accessorKey: 'delayed',
        header: '延误',
        enableSorting: false,
        cell: ({ getValue }) =>
          getValue() ? (
            <Badge className="whitespace-nowrap bg-red-100 text-red-700">延误</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    []
  )

  // 状态筛选（前端过滤，等价于列筛选）
  const filteredRows = useMemo(() => {
    if (statusFilter === 'ALL') return rows
    return rows.filter((r) => r.status === statusFilter)
  }, [rows, statusFilter])

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const handleExport = () => {
    const sorted = table.getSortedRowModel().rows.map((r) => r.original)
    exportToExcel(sorted, projectCode)
  }

  return (
    <div className="space-y-3">
      {/* 工具栏：状态筛选 + 导出 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">状态筛选</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              {PHASE_STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {PHASE_STATUS_META[s]?.label ?? s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="mr-2 h-4 w-4" />
          导出 Excel
        </Button>
      </div>

      {/* 全字段矩阵 */}
      <div className="overflow-hidden rounded-xl border">
        <div className="relative w-full overflow-auto">
          <table className="w-full caption-bottom text-sm">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b bg-muted/60">
                  {headerGroup.headers.map((header) => {
                    const sortable = header.column.getCanSort()
                    const sorted = header.column.getIsSorted()
                    return (
                      <th
                        key={header.id}
                        className="h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-muted-foreground"
                        onClick={
                          sortable ? header.column.getToggleSortingHandler() : undefined
                        }
                      >
                        {header.isPlaceholder ? null : (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              sortable && 'cursor-pointer select-none hover:text-foreground'
                            )}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sortable &&
                              (sorted === 'asc' ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : sorted === 'desc' ? (
                                <ArrowDown className="h-3 w-3" />
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-40" />
                              ))}
                          </span>
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="h-32 text-center text-muted-foreground"
                  >
                    暂无阶段数据
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b transition-colors odd:bg-muted/25 hover:bg-muted/50">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="whitespace-nowrap px-3 py-2.5 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        共 {filteredRows.length} 个阶段
        {statusFilter !== 'ALL' && `（已按「${PHASE_STATUS_META[statusFilter]?.label}」筛选）`}
      </p>
    </div>
  )
}

// ───────────────────────────── 主内容（读 ?projectId=）─────────────────────────────

function TableView() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  const { data: tree, isLoading } = useQuery({
    queryKey: ['project', projectId, 'tree'],
    enabled: !!projectId,
    queryFn: async (): Promise<TreeBody> => {
      const res = await api.get(`/projects/${projectId}/tree`)
      const body = res.data as { data?: TreeBody }
      return body?.data ?? { phases: [] }
    },
  })

  const rows: PhaseRow[] = useMemo(() => {
    return (tree?.phases ?? []).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      order: p.order,
      status: p.status,
      ownerName: p.owner?.name ?? '',
      plannedStart: p.plannedStart ?? null,
      plannedEnd: p.plannedEnd ?? null,
      actualEnd: p.actualEnd ?? null,
      progress: p.progress ?? 0,
      taskCount: p.taskCount ?? 0,
      taskDone: p.taskDone ?? 0,
      fileApproved: p.fileStats?.approved ?? 0,
      fileTotal: p.fileStats?.total ?? 0,
      delayed: !!p.delayed,
    }))
  }, [tree])

  if (!projectId) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <FolderKanban className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            请先在顶部选择一个项目，以查看该项目的阶段全字段矩阵。
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Table2 className="h-5 w-5" />
          阶段全字段矩阵
        </CardTitle>
        <CardDescription>
          {tree?.project?.name ? `${tree.project.name} · ` : ''}共 {rows.length} 个阶段 · 支持列排序与状态筛选 · 可导出 Excel
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : (
          <PhaseMatrix rows={rows} projectCode={tree?.project?.code} />
        )}
      </CardContent>
    </Card>
  )
}

// ───────────────────────────── 页面出口 ─────────────────────────────

export default function TableViewPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-10 animate-pulse rounded bg-muted" />}>
        <ProjectViewPicker />
      </Suspense>
      <Suspense fallback={<div className="h-32 animate-pulse rounded bg-muted" />}>
        <TableView />
      </Suspense>
    </div>
  )
}
