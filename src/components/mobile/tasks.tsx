'use client'

/**
 * MobileTasks —— 任务页移动子树（375-430px 卡片流）。
 * 筛选收进底部 Sheet（状态/优先级/排序 chips）；列表触底翻页累积；
 * 数据由页面传入（复用页面 useQuery，不重复请求）；桌面 JSX 原样保留在页面内。
 */

import { useEffect, useRef, useState } from 'react'
import { Filter, ListTodo, Plus, RotateCcw } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { MobileFab } from './fab'
import { MobileList, MobileListItem } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { MobileSearchBar } from './search-bar'
import { MobileEmptyState } from './empty-state'
import { cn, formatDate } from '@/lib/utils'
import { label, TASK_STATUS, PRIORITY } from '@/lib/labels'
import type { Task } from '@/types'

/** 状态 → chip tone（与桌面 Badge 语义对齐：TODO灰/进行中蓝/审核黄/完成绿） */
const STATUS_TONE: Record<string, MobileChipTone> = {
  TODO: 'default',
  IN_PROGRESS: 'info',
  REVIEW: 'warning',
  DONE: 'success',
}
/** 优先级 → chip tone（紧急红/高橙，与桌面 destructive 语义对齐并细化） */
const PRIORITY_TONE: Record<string, MobileChipTone> = {
  URGENT: 'danger',
  HIGH: 'warning',
  MEDIUM: 'default',
  LOW: 'default',
}

const STATUS_OPTIONS = [
  ['all', '全部'],
  ['TODO', '待办'],
  ['IN_PROGRESS', '进行中'],
  ['REVIEW', '审核中'],
  ['DONE', '已完成'],
] as const

const PRIORITY_OPTIONS = [
  ['all', '全部'],
  ['URGENT', '紧急'],
  ['HIGH', '高'],
  ['MEDIUM', '中'],
  ['LOW', '低'],
] as const

const SORT_OPTIONS = [
  ['createdAt-desc', '最新创建'],
  ['createdAt-asc', '最早创建'],
  ['updatedAt-desc', '最近更新'],
  ['dueDate-asc', '截止日期'],
] as const

/** chips 单选行（触控 ≥44px，pill 形） */
function ChipRow({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<readonly [string, string]>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'min-h-11 rounded-full px-4 text-sm transition-colors',
            value === v
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground active:bg-muted/70',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

export function MobileTasks({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  priorityFilter,
  onPriorityChange,
  sortKey,
  onSortChange,
  page,
  onPageChange,
  tasks,
  isLoading,
  pages,
  total,
  onOpenTask,
  onCreate,
}: {
  searchTerm: string
  onSearchChange: (v: string) => void
  statusFilter: string
  onStatusChange: (v: string) => void
  priorityFilter: string
  onPriorityChange: (v: string) => void
  sortKey: string
  onSortChange: (v: string) => void
  page: number
  onPageChange: (p: number) => void
  /** 当前页任务（页面 useQuery 数据） */
  tasks: Task[]
  isLoading: boolean
  pages: number
  total: number
  onOpenTask: (id: string) => void
  onCreate: () => void
}) {
  const [filterOpen, setFilterOpen] = useState(false)
  /** 筛选草稿（打开时从页面 state 初始化，应用时才写回） */
  const [draftStatus, setDraftStatus] = useState(statusFilter)
  const [draftPriority, setDraftPriority] = useState(priorityFilter)
  const [draftSort, setDraftSort] = useState(sortKey)
  useEffect(() => {
    if (filterOpen) {
      setDraftStatus(statusFilter)
      setDraftPriority(priorityFilter)
      setDraftSort(sortKey)
    }
  }, [filterOpen, statusFilter, priorityFilter, sortKey])

  const activeCount = (statusFilter !== 'all' ? 1 : 0) + (priorityFilter !== 'all' ? 1 : 0)

  /** 触底加载：翻页累积（筛选/搜索/排序变化 → page 重置 1 → 重置累积） */
  const filterKey = `${searchTerm}|${statusFilter}|${priorityFilter}|${sortKey}`
  const [acc, setAcc] = useState<Task[]>(tasks)
  const lastKeyRef = useRef(filterKey)
  useEffect(() => {
    if (page === 1 || lastKeyRef.current !== filterKey) {
      lastKeyRef.current = filterKey
      setAcc(tasks)
    } else {
      setAcc((prev) => {
        const seen = new Set(prev.map((t) => t.id))
        return [...prev, ...tasks.filter((t) => !seen.has(t.id))]
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, page, filterKey])

  const hasMore = page < pages
  const loadingMore = isLoading && page > 1

  /** 触底哨兵：进入视口即翻下一页 */
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) onPageChange(page + 1)
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, isLoading, page, onPageChange])

  const apply = () => {
    onStatusChange(draftStatus)
    onPriorityChange(draftPriority)
    onSortChange(draftSort)
    onPageChange(1)
    setFilterOpen(false)
  }
  const reset = () => {
    setDraftStatus('all')
    setDraftPriority('all')
    setDraftSort('createdAt-desc')
  }

  return (
    <div className="space-y-3 pt-1">
      {/* 搜索 + 筛选入口 */}
      <div className="flex items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <MobileSearchBar
            value={searchTerm}
            onChange={(v) => {
              onSearchChange(v)
              onPageChange(1)
            }}
            placeholder="搜索任务..."
          />
        </div>
        <button
          type="button"
          onClick={() => setFilterOpen(true)}
          aria-label="筛选"
          className={cn(
            'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-card',
            activeCount > 0 ? 'border-primary/40 text-primary' : 'text-muted-foreground',
          )}
        >
          <Filter className="h-5 w-5" />
          {activeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none text-white">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {/* 结果计数 */}
      <p className="px-4 text-xs text-muted-foreground">共 {total} 条任务</p>

      {/* 任务卡片流 */}
      <div className="px-3">
        <MobileList
          items={acc}
          keyOf={(t) => t.id}
          loading={isLoading && page === 1}
          empty={
            <MobileEmptyState
              icon={ListTodo}
              title="暂无任务"
              desc={searchTerm ? '没有找到匹配的任务' : '点击右下角 + 创建第一个任务'}
            />
          }
          renderItem={(t) => (
            <MobileListItem
              key={t.id}
              onClick={() => onOpenTask(t.id)}
              title={t.title}
              subtitle={
                `${(t.project as { name?: string } | undefined)?.name ?? '未分配项目'} · ` +
                `${(t.assignee as { name?: string } | undefined)?.name ?? '未指派'}` +
                (t.dueDate ? ` · ${formatDate(t.dueDate)}` : '')
              }
              status={
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <MobileStatusChip
                    label={label(PRIORITY, t.priority)}
                    tone={PRIORITY_TONE[t.priority] ?? 'default'}
                  />
                  <MobileStatusChip
                    label={label(TASK_STATUS, t.status)}
                    tone={STATUS_TONE[t.status] ?? 'default'}
                  />
                </span>
              }
            />
          )}
        />
        {/* 触底哨兵 + 加载/到底提示 */}
        <div ref={sentinelRef} className="h-1" />
        {loadingMore && <p className="py-3 text-center text-xs text-muted-foreground">加载中…</p>}
        {!hasMore && acc.length > 0 && (
          <p className="py-3 text-center text-xs text-muted-foreground">— 已全部加载 —</p>
        )}
      </div>

      {/* FAB 新建（打开页面现有新建 Dialog，本期容器共用） */}
      <MobileFab icon={Plus} label="新建任务" onClick={onCreate} />

      {/* 筛选底部抽屉 */}
      <Sheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="筛选任务"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={reset}
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm text-foreground active:bg-muted/60"
            >
              <RotateCcw className="h-4 w-4" />
              重置
            </button>
            <button
              type="button"
              onClick={apply}
              className="btn-gradient flex h-11 flex-[2] items-center justify-center rounded-lg text-sm font-medium"
            >
              应用筛选
            </button>
          </div>
        }
      >
        <div className="space-y-5 pb-2">
          <section>
            <h4 className="mb-2.5 text-sm font-medium">状态</h4>
            <ChipRow options={STATUS_OPTIONS} value={draftStatus} onChange={setDraftStatus} />
          </section>
          <section>
            <h4 className="mb-2.5 text-sm font-medium">优先级</h4>
            <ChipRow options={PRIORITY_OPTIONS} value={draftPriority} onChange={setDraftPriority} />
          </section>
          <section>
            <h4 className="mb-2.5 text-sm font-medium">排序</h4>
            <ChipRow options={SORT_OPTIONS} value={draftSort} onChange={setDraftSort} />
          </section>
        </div>
      </Sheet>
    </div>
  )
}
