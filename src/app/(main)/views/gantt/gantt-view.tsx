'use client'

/**
 * GanttView —— P3 甘特图视图实现（§8.2⑤）+ 专业版交互优化
 *
 * 数据源：
 *   - GET /api/projects/:id/tree   → data.project + data.phases[]（Phase 父条）
 *   - GET /api/tasks?projectId=（分页循环拉全量，fetchAllTasks）→ data.items[]（Task 子条）
 *
 * 结构（双层）：
 *   - Phase 父条 = type 'project'，起止 plannedStart→plannedEnd，名称 `PHxx 阶段名`，
 *     进度 progress，依赖 = 前一个 Phase（顺序连线 PH01→PH02→…）
 *   - Task 子条 = type 'task'，起止 startedAt→dueDate（startedAt 空则用所属 Phase 的
 *     plannedStart；dueDate 空 → 不画条，进「未排期」列表），project = 所属 Phase 的 id
 *
 * 拖拽改期（PATCH）：
 *   - Phase 父条 → PATCH /api/phases/:id { plannedStart, plannedEnd }
 *   - Task 子条 → PATCH /api/tasks/:id { dueDate }
 *     ⚠️ /api/tasks/:id 的 PATCH 白名单只含 dueDate（无 startedAt），故任务条的
 *     「开始端」单独拖拽无法持久化，会回滚并提示；「结束端/整体移动」按 dueDate 落库。
 *
 * 交互优化（本次）：
 *   - 占满可视区：外层 flex 列布局 + 甘特图区 flex-1，ganttHeight 由 ResizeObserver 实测
 *   - 宽度占满：(main)/layout.tsx 已改为通栏布局（w-full，无 container 限宽）
 *   - 横向：底部水平滚动条 + 在空白处按住鼠标拖拽平移（左侧任务列天然固定）
 *   - 纵向：任务超出可视高度时右侧纵向滚动条 + 滚轮滚动
 *   - 缩放：放大/缩小/重置按钮（调整 columnWidth），实时显示缩放百分比
 *   - 今日线：红色竖线覆盖层 + 顶部「今天」标记，随滚动实时更新；「回到今天」按钮
 *   - 视觉：Phase 父条（状态色 + 进度填充）/ Task 子条（状态色）、圆角、投影、中文列表头
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Gantt, ViewMode, type Task as GanttTask } from 'gantt-task-react'
import 'gantt-task-react/dist/index.css'
import toast from 'react-hot-toast'

import { ProjectViewPicker } from '@/components/views/project-view-picker'
import { ProjectDetailService } from '@/services/project-detail'
import { ApiService } from '@/services/api'
import { fetchAllTasks } from '@/services/view-data'
import type { PhaseTreeNode, PhaseStatus } from '@/types/project-tree'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  CalendarRange,
  Clock,
  Loader2,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react'

// ───────────────────────────── 状态色（§8.2⑤） ─────────────────────────────

const PHASE_COLORS: Record<PhaseStatus, string> = {
  NOT_STARTED: '#94a3b8',
  IN_PROGRESS: '#3b82f6',
  DONE: '#10b981',
  PAUSED: '#f59e0b',
  SKIPPED: '#94a3b8',
}

const PHASE_LABELS: Record<PhaseStatus, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  PAUSED: '已暂停',
  SKIPPED: '已跳过',
}

const TASK_COLORS: Record<string, string> = {
  TODO: '#94a3b8',
  IN_PROGRESS: '#3b82f6',
  REVIEW: '#8b5cf6',
  DONE: '#10b981',
  CANCELLED: '#ef4444',
}

const TASK_LABELS: Record<string, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  REVIEW: '评审',
  DONE: '已完成',
  CANCELLED: '已取消',
}

/** GET /api/tasks 分页项（§7.6 契约 + startedAt/completedAt 标量） */
interface TaskItem {
  id: string
  title: string
  status: string
  priority: string
  phaseId: string | null
  phase?: { id: string; code: string; name: string } | null
  assignee?: { id: string; name: string } | null
  dueDate: string | null
  startedAt: string | null
  completedAt: string | null
}

// ───────────────────────────── 工具函数 ─────────────────────────────

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function toDayStart(v: string | null | undefined): Date | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return dayStart(d)
}

/** Date → 'YYYY-MM-DD'（本地时区，日粒度落库） */
function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function clampProgress(p: number): number {
  if (Number.isNaN(p)) return 0
  return Math.max(0, Math.min(100, Math.round(p)))
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function phaseLabel(p: PhaseTreeNode): string {
  const code = p.code || `PH${String(p.order).padStart(2, '0')}`
  return `${code} ${p.name}`
}

// ───────────────────────────── 视图 / 缩放配置 ─────────────────────────────

const VIEW_MODE_OPTIONS: { key: ViewMode; label: string }[] = [
  { key: ViewMode.Day, label: '日' },
  { key: ViewMode.Week, label: '周' },
  { key: ViewMode.Month, label: '月' },
]

/** 各视图模式的基准列宽（zoom=100%） */
const BASE_COLUMN_WIDTH: Record<ViewMode, number> = {
  [ViewMode.Day]: 60,
  [ViewMode.Week]: 72,
  [ViewMode.Month]: 90,
  [ViewMode.Hour]: 40,
  [ViewMode.QuarterDay]: 40,
  [ViewMode.HalfDay]: 40,
  [ViewMode.Year]: 120,
}

const MIN_COLUMN_WIDTH = 24
const MAX_COLUMN_WIDTH = 220
const MIN_ZOOM = 0.4
const MAX_ZOOM = 3
const ZOOM_STEP = 1.25

const HEADER_HEIGHT = 50
/** 底部水平滚动条预留高度（库内 1.2rem） */
const HSCROLL_RESERVE = 20

// ───────────────────────────── 自定义列表头（中文单列） ─────────────────────────────

/**
 * 替换库默认三列英文表头（Name/From/To），改为单列中文表头，
 * 使左侧任务列宽度 = listCellWidth，避免默认表头把列表撑到 3 倍宽。
 */
function GanttListHeader({
  headerHeight,
  rowWidth,
  fontFamily,
  fontSize,
}: {
  headerHeight: number
  rowWidth: string
  fontFamily: string
  fontSize: string
}) {
  return (
    <div
      style={{
        fontFamily,
        fontSize,
        display: 'flex',
        alignItems: 'center',
        height: headerHeight - 2,
        borderBottom: '1px solid rgb(228, 228, 231)',
      }}
    >
      <div
        style={{ minWidth: rowWidth, paddingLeft: 12 }}
        className="font-medium text-muted-foreground"
      >
        阶段 / 任务
      </div>
    </div>
  )
}

// ───────────────────────────── 滚动元素探测（拖拽平移 / 滚轮用） ─────────────────────────────

function findScrollables(shell: HTMLElement): { h: HTMLElement | null; v: HTMLElement | null } {
  let h: HTMLElement | null = null
  let v: HTMLElement | null = null
  shell.querySelectorAll('div').forEach((el) => {
    const st = getComputedStyle(el)
    if (!h && (st.overflowX === 'auto' || st.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      h = el as HTMLElement
    }
    if (!v && (st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      v = el as HTMLElement
    }
  })
  return { h, v }
}

function canScrollX(el: HTMLElement, delta: number): boolean {
  if (delta > 0) return el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  return el.scrollLeft > 0
}

function canScrollY(el: HTMLElement, delta: number): boolean {
  if (delta > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1
  return el.scrollTop > 0
}

// ───────────────────────────── 主组件 ─────────────────────────────

export function GanttView() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''
  const queryClient = useQueryClient()
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.Day)

  // 交互状态
  const [zoom, setZoom] = useState(1)
  const [showUndated, setShowUndated] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [todayLeft, setTodayLeft] = useState<number | null>(null)
  const [narrow, setNarrow] = useState(false) // ≤640px 视口：收窄左侧任务列

  const shellRef = useRef<HTMLDivElement>(null) // 包裹 <Gantt/> + 今日线覆盖层
  const measureRef = useRef<HTMLDivElement>(null) // 高度实测容器
  const [chartHeight, setChartHeight] = useState(0)
  const panState = useRef<{
    startX: number
    startY: number
    sl: number
    st: number
    h: HTMLElement | null
    v: HTMLElement | null
    moved: boolean
  } | null>(null)

  // 项目根树（Phase 父条数据源，§7.4 契约）
  const treeQuery = useQuery({
    queryKey: ['project', projectId, 'tree'],
    queryFn: () => ProjectDetailService.getTree(projectId),
    enabled: !!projectId,
  })

  // 全量任务（Task 子条数据源；分页循环拉全量，规避后端 limit=100 硬上限）
  const tasksQuery = useQuery({
    queryKey: ['project', projectId, 'tasks'],
    queryFn: () => fetchAllTasks<TaskItem>(projectId),
    enabled: !!projectId,
  })

  const project = treeQuery.data?.data?.project ?? null
  const phases = treeQuery.data?.data?.phases ?? []
  const tasks = tasksQuery.data ?? []

  // 窄视口检测（左侧任务列收窄，避免 375px 手机溢出）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    setNarrow(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 甘特图容器高度实测（flex-1 区域内，减去表头 + 水平滚动条后传给 ganttHeight）
  const chartMounted =
    !!projectId && !treeQuery.isLoading && !tasksQuery.isLoading && !treeQuery.isError && !tasksQuery.isError
  useEffect(() => {
    const el = measureRef.current
    if (!el) {
      setChartHeight(0)
      return
    }
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0
      setChartHeight(Math.floor(h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [chartMounted])

  const ganttHeight = Math.max(chartHeight - HEADER_HEIGHT - HSCROLL_RESERVE, 120)
  const columnWidth = Math.max(
    MIN_COLUMN_WIDTH,
    Math.min(MAX_COLUMN_WIDTH, Math.round(BASE_COLUMN_WIDTH[viewMode] * zoom))
  )

  // ── 组装 gantt-task-react 双层任务 ──
  const { ganttTasks, undatedTasks } = useMemo(() => {
    const projStart = toDayStart(project?.plannedStart)
    const projEnd = toDayStart(project?.plannedEnd)
    const today = dayStart(new Date())

    const result: GanttTask[] = []
    const undated: TaskItem[] = []

    const orderedPhases = [...phases].sort((a, b) => a.order - b.order)
    const phaseStartMap = new Map<string, Date>()

    orderedPhases.forEach((p, idx) => {
      const parentId = `phase-${p.id}`
      const start = toDayStart(p.plannedStart) ?? projStart ?? today
      let end = toDayStart(p.plannedEnd) ?? start
      if (end <= start) end = addDays(start, 1)
      phaseStartMap.set(p.id, start)

      const color = PHASE_COLORS[p.status] ?? '#94a3b8'

      result.push({
        id: parentId,
        type: 'project',
        name: phaseLabel(p),
        start,
        end,
        progress: clampProgress(p.progress),
        styles: {
          backgroundColor: hexToRgba(color, 0.32),
          backgroundSelectedColor: hexToRgba(color, 0.55),
          progressColor: color,
          progressSelectedColor: color,
        },
        // 依赖箭头：Phase 顺序连线 PH01→PH02→…（§8.2⑤；Task 级依赖 schema 缺失，不连）
        dependencies: idx > 0 ? [`phase-${orderedPhases[idx - 1].id}`] : undefined,
        displayOrder: p.order * 1000,
      })

      // Task 子条（project 归属父条）
      const children = tasks.filter((t) => t.phaseId === p.id)
      children.forEach((t, ci) => {
        const endD = toDayStart(t.dueDate)
        if (!endD) {
          undated.push(t) // dueDate 空 → 未排期
          return
        }
        const startD = toDayStart(t.startedAt) ?? phaseStartMap.get(p.id) ?? projStart ?? today
        const s = startD > endD ? endD : startD
        const c = TASK_COLORS[t.status] ?? '#94a3b8'
        result.push({
          id: t.id,
          type: 'task',
          name: t.title,
          start: s,
          end: endD,
          progress: 0,
          project: parentId,
          styles: {
            backgroundColor: hexToRgba(c, 0.32),
            backgroundSelectedColor: hexToRgba(c, 0.55),
            progressColor: c,
            progressSelectedColor: c,
          },
          displayOrder: p.order * 1000 + ci + 1,
        })
      })
    })

    // 无阶段的顶层任务（仍属项目，渲染为顶层条）
    const unphased = tasks.filter((t) => !t.phaseId)
    unphased.forEach((t, i) => {
      const endD = toDayStart(t.dueDate)
      if (!endD) {
        undated.push(t)
        return
      }
      const startD = toDayStart(t.startedAt) ?? projStart ?? today
      const s = startD > endD ? endD : startD
      const c = TASK_COLORS[t.status] ?? '#94a3b8'
      result.push({
        id: t.id,
        type: 'task',
        name: t.title,
        start: s,
        end: endD,
        progress: 0,
        styles: {
          backgroundColor: hexToRgba(c, 0.32),
          backgroundSelectedColor: hexToRgba(c, 0.55),
          progressColor: c,
          progressSelectedColor: c,
        },
        displayOrder: 1000000 + i,
      })
    })

    return { ganttTasks: result, undatedTasks: undated }
  }, [phases, tasks, project])

  const hasChart = !!projectId && ganttTasks.length > 0 && chartHeight > 0

  // ── 今日线覆盖层位置（随缩放/视图模式/滚动实时更新） ──
  const updateToday = useCallback(() => {
    const shell = shellRef.current
    if (!shell) {
      setTodayLeft(null)
      return
    }
    const chartEl = shell.querySelector<HTMLElement>('div[dir="ltr"]')
    const rect = shell.querySelector('g.today rect')
    const x = rect?.getAttribute('x')
    const w = rect?.getAttribute('width')
    if (!chartEl || !x || !w) {
      setTodayLeft(null)
      return
    }
    const center = parseFloat(x) + parseFloat(w) / 2
    const left = chartEl.offsetLeft + center - chartEl.scrollLeft
    // 滚出可视区（左侧任务列之前 / 容器右侧之外）时隐藏
    if (left < chartEl.offsetLeft - 8 || left > shell.clientWidth + 8) {
      setTodayLeft(null)
      return
    }
    setTodayLeft(left)
  }, [])

  useEffect(() => {
    if (!hasChart) {
      setTodayLeft(null)
      return
    }
    const raf = requestAnimationFrame(updateToday)
    const shell = shellRef.current
    // 捕获阶段监听内部滚动（时间线容器 + 库的伪滚动条），实时跟进今日线
    const onScroll = () => updateToday()
    shell?.addEventListener('scroll', onScroll, true)
    const ro = new ResizeObserver(updateToday)
    if (shell) ro.observe(shell)
    return () => {
      cancelAnimationFrame(raf)
      shell?.removeEventListener('scroll', onScroll, true)
      ro.disconnect()
    }
  }, [hasChart, updateToday, ganttTasks, viewMode, columnWidth, ganttHeight])

  // ── 滚轮：纵向滚动画布；shift/横向滚动 → 横向平移 ──
  useEffect(() => {
    if (!hasChart) return
    const shell = shellRef.current
    if (!shell) return
    const onWheel = (e: WheelEvent) => {
      const { h, v } = findScrollables(shell)
      const dx = e.deltaX
      const dy = e.deltaY
      if (Math.abs(dx) > Math.abs(dy)) {
        if (h && canScrollX(h, dx)) {
          h.scrollLeft += dx
          e.preventDefault()
        }
      } else if (e.shiftKey) {
        if (h && canScrollX(h, dy)) {
          h.scrollLeft += dy
          e.preventDefault()
        }
      } else {
        if (v && canScrollY(v, dy)) {
          v.scrollTop += dy
          e.preventDefault()
        } else if (h && canScrollX(h, dy)) {
          // 纵向滚到头后继续滚轮 → 横向平移（常见甘特图交互）
          h.scrollLeft += dy
          e.preventDefault()
        }
      }
    }
    shell.addEventListener('wheel', onWheel, { passive: false })
    return () => shell.removeEventListener('wheel', onWheel)
  }, [hasChart, ganttTasks, viewMode, columnWidth, ganttHeight])

  // ── 鼠标拖拽平移（在空白处按下拖动；按在任务条上则交给库的改期拖拽） ──
  const onShellMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('g.bar') || target.closest('button, a, input')) return // 不抢占条形拖拽
    const shell = shellRef.current
    if (!shell) return
    const { h, v } = findScrollables(shell)
    if (!h && !v) return
    e.preventDefault()
    panState.current = {
      startX: e.clientX,
      startY: e.clientY,
      sl: h?.scrollLeft ?? 0,
      st: v?.scrollTop ?? 0,
      h,
      v,
      moved: false,
    }
    const onMove = (ev: MouseEvent) => {
      const p = panState.current
      if (!p) return
      const dx = ev.clientX - p.startX
      const dy = ev.clientY - p.startY
      if (!p.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        p.moved = true
        setIsPanning(true)
      }
      if (p.h) p.h.scrollLeft = p.sl - dx
      if (p.v) p.v.scrollTop = p.st - dy
      if (p.moved) ev.preventDefault()
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      panState.current = null
      setIsPanning(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── 缩放控制 ──
  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, +(z * ZOOM_STEP).toFixed(2)))
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, +(z / ZOOM_STEP).toFixed(2)))
  const zoomReset = () => setZoom(1)

  /** 回到今天：把今日线滚到视口中央（今日不在范围内时滚到最右） */
  const scrollToToday = () => {
    const shell = shellRef.current
    if (!shell) return
    const { h } = findScrollables(shell)
    if (!h) return
    const rect = shell.querySelector('g.today rect')
    const x = rect?.getAttribute('x')
    const w = rect?.getAttribute('width')
    if (!x || !w) {
      h.scrollLeft = h.scrollWidth
      return
    }
    const center = parseFloat(x) + parseFloat(w) / 2
    h.scrollLeft = Math.max(0, center - h.clientWidth / 2)
  }

  // ── 拖拽改期 → PATCH（§8.2⑤）──
  const handleDateChange = async (task: GanttTask): Promise<boolean> => {
    try {
      if (task.type === 'project') {
        // Phase 父条：plannedStart + plannedEnd 均可改
        const phaseId = task.id.replace(/^phase-/, '')
        await ApiService.patch(`/phases/${phaseId}`, {
          plannedStart: toDateOnly(task.start),
          plannedEnd: toDateOnly(task.end),
        })
        await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
        toast.success('阶段日期已更新')
        return true
      }

      // Task 子条：PATCH 白名单只有 dueDate（无 startedAt）
      const orig = ganttTasks.find((t) => t.id === task.id)
      const endChanged = !orig || task.end.getTime() !== orig.end.getTime()
      if (!endChanged) {
        toast('任务开始时间暂不可修改（接口仅支持截止日期）')
        return false
      }
      await ApiService.patch(`/tasks/${task.id}`, { dueDate: toDateOnly(task.end) })
      await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tasks'] })
      await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
      toast.success('任务截止日期已更新')
      return true
    } catch (e) {
      toast.error('改期失败，请重试')
      return false
    }
  }

  const isLoading = (!!projectId && treeQuery.isLoading) || tasksQuery.isLoading
  const isError = treeQuery.isError || tasksQuery.isError

  return (
    <div className="flex h-[calc(100vh-120px)] min-h-[540px] flex-col gap-3">
      <ProjectViewPicker />

      {!projectId ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-card">
          <div className="py-12 text-center">
            <CalendarRange className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              请先在顶部选择一个项目，查看其甘特图（阶段 + 任务双层时间线）
            </p>
          </div>
        </div>
      ) : isLoading ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">加载甘特图数据…</span>
          </div>
        </div>
      ) : isError ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-border bg-card">
          <p className="text-sm text-red-500">加载失败，请刷新重试</p>
        </div>
      ) : (
        <>
          {/* ── 工具栏：项目信息 | 未排期 | 缩放 | 视图模式 ── */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="max-w-[220px] truncate font-medium text-foreground">
                {project?.name ?? '项目'}
              </span>
              <span className="text-muted-foreground/60">·</span>
              <span className="whitespace-nowrap">
                {phases.length} 个阶段 / {tasks.length} 个任务
              </span>
              {undatedTasks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUndated((s) => !s)}
                  className={cn(
                    'flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs transition-colors hover:bg-accent',
                    showUndated && 'bg-accent'
                  )}
                >
                  <Clock className="h-3.5 w-3.5" />
                  未排期 <Badge variant="secondary" className="px-1 py-0 text-[10px]">{undatedTasks.length}</Badge>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* 缩放控制 */}
              <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
                <button
                  type="button"
                  onClick={zoomOut}
                  disabled={zoom <= MIN_ZOOM + 0.001}
                  title="缩小"
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="w-12 select-none text-center text-xs tabular-nums text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={zoomIn}
                  disabled={zoom >= MAX_ZOOM - 0.001}
                  title="放大"
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={zoomReset}
                  title="重置缩放"
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* 回到今天 */}
              <button
                type="button"
                onClick={scrollToToday}
                className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LocateFixed className="h-3.5 w-3.5" />
                回到今天
              </button>

              {/* 日 / 周 / 月 */}
              <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
                {VIEW_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setViewMode(opt.key)}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                      viewMode === opt.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── 未排期任务（可折叠） ── */}
          {showUndated && undatedTasks.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-card px-4 py-2">
              {undatedTasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between border-b py-1.5 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.phase ? `${t.phase.code} ${t.phase.name}` : '未挂阶段'}
                    </p>
                  </div>
                  <Badge variant="outline" className="ml-3 shrink-0">
                    {TASK_LABELS[t.status] ?? t.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          {/* ── 甘特图主体（占满剩余可视区） ── */}
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            {ganttTasks.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">该项目暂无已排期的阶段或任务</p>
              </div>
            ) : (
              <div ref={measureRef} className="absolute inset-0">
                {chartHeight > 0 && (
                  <div
                    ref={shellRef}
                    className={cn('gantt-shell relative h-full w-full select-none', isPanning ? 'cursor-grabbing' : 'cursor-grab')}
                    onMouseDown={onShellMouseDown}
                  >
                    <Gantt
                      tasks={ganttTasks}
                      viewMode={viewMode}
                      locale="zh-CN"
                      listCellWidth={narrow ? '150px' : '260px'}
                      rowHeight={36}
                      headerHeight={HEADER_HEIGHT}
                      ganttHeight={ganttHeight}
                      barFill={70}
                      barCornerRadius={6}
                      columnWidth={columnWidth}
                      fontSize="12px"
                      fontFamily="inherit"
                      todayColor="rgba(239, 68, 68, 0.08)"
                      arrowColor="#94a3b8"
                      arrowIndent={20}
                      timeStep={24 * 60 * 60 * 1000}
                      TaskListHeader={GanttListHeader}
                      onDateChange={handleDateChange}
                    />

                    {/* 今日线覆盖层：红色竖线 + 顶部「今天」标记 */}
                    {todayLeft !== null && (
                      <>
                        <div
                          className="pointer-events-none absolute top-0 z-10 w-0.5 bg-red-500"
                          style={{ left: todayLeft - 1, height: HEADER_HEIGHT + ganttHeight }}
                        />
                        <div
                          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white shadow"
                          style={{ left: todayLeft }}
                        >
                          今天
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── 图例 ── */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm border border-blue-400/40 bg-blue-500/30" />
              阶段（父条，含进度）
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm bg-blue-500/30" />
              任务（子条）
            </span>
            <span className="hidden text-muted-foreground/60 sm:inline">|</span>
            {(Object.keys(PHASE_COLORS) as PhaseStatus[]).map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PHASE_COLORS[k] }} />
                阶段·{PHASE_LABELS[k]}
              </span>
            ))}
            <span className="hidden text-muted-foreground/60 sm:inline">|</span>
            {Object.entries(TASK_COLORS).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: v }} />
                {TASK_LABELS[k] ?? k}
              </span>
            ))}
            <span className="hidden text-muted-foreground/60 sm:inline">|</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-0.5 bg-red-500" />
              今天
            </span>
            <span className="ml-auto hidden text-muted-foreground/70 md:inline">
              拖动条形改期 · 空白处按住拖拽平移 · 滚轮滚动
            </span>
          </div>
        </>
      )}
    </div>
  )
}
