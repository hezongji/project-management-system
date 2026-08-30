'use client'

/**
 * MobileTodos —— 待办中心移动子树。
 * MobileSegmentedTabs（我的待办/催办中心，催办带红色 count）+ 卡片流；
 * 数据与操作回调由页面传入；URL ?src=催办 默认 Tab 的逻辑留在页面层。
 */

import {
  BellRing,
  CheckCircle,
  CheckCircle2,
  Clock,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react'
import { MobileList } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { MobileSegmentedTabs } from './segmented-tabs'
import { MobileEmptyState } from './empty-state'
import { cn, formatDate, formatRelativeTime } from '@/lib/utils'
import { label, PRIORITY } from '@/lib/labels'

/** 与页面 GET /todos、GET /urges/mine 返回契约对齐（宽松视图层类型） */
interface TodoItem {
  id: string
  title: string
  sourceType: string
  link?: string | null
  dueAt?: string | null
  priority: string
}
interface UrgeItem {
  id: string
  projectId: string
  projectCode: string
  requirementId: string
  requirementName: string
  urgedBy?: { name: string } | null
  targetUser?: { name: string } | null
  createdAt: string
  doneAt?: string | null
}

/** 优先级 → chip tone（与桌面 Badge 语义对齐） */
const PRIORITY_TONE: Record<string, MobileChipTone> = {
  URGENT: 'danger',
  HIGH: 'warning',
  MEDIUM: 'default',
  LOW: 'default',
}

export function MobileTodos({
  tab,
  onTabChange,
  doneFilter,
  onDoneFilterChange,
  todos,
  todosLoading,
  incoming,
  outgoing,
  recentlyDone,
  urgesLoading,
  togglingId,
  onToggleTodo,
  onDeleteUrge,
  onUrgeFile,
  onTodoOpen,
}: {
  tab: 'todo' | 'urge'
  onTabChange: (t: 'todo' | 'urge') => void
  doneFilter: 0 | 1
  onDoneFilterChange: (v: 0 | 1) => void
  todos: TodoItem[]
  todosLoading: boolean
  incoming: UrgeItem[]
  outgoing: UrgeItem[]
  recentlyDone: UrgeItem[]
  urgesLoading: boolean
  togglingId: string | null
  onToggleTodo: (t: TodoItem) => void
  onDeleteUrge: (id: string, name: string) => void
  onUrgeFile: (u: UrgeItem) => void
  /** 待办行点击跳转（页面层包装 todoLinkTarget + router.push） */
  onTodoOpen: (t: TodoItem) => void
}) {
  return (
    <div className="space-y-3 pt-1">
      {/* 催办待处理横幅（有催办才显示，点击切到催办中心） */}
      {incoming.length > 0 && tab === 'todo' && (
        <button
          type="button"
          onClick={() => onTabChange('urge')}
          className="mx-3 flex min-h-11 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 text-sm text-destructive"
        >
          <BellRing className="h-4 w-4 shrink-0" />
          {incoming.length} 条催办待处理，点击查看
        </button>
      )}

      {/* 顶部 SegmentedTabs（催办中心带红色 count） */}
      <MobileSegmentedTabs
        tabs={[
          { key: 'todo', label: '我的待办', count: doneFilter === 0 ? todos.length : undefined },
          { key: 'urge', label: '催办中心', count: incoming.length },
        ]}
        active={tab}
        onChange={(k) => onTabChange(k as 'todo' | 'urge')}
      />

      {tab === 'todo' ? (
        /* ── Tab 1：我的待办 ── */
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 px-4">
            <span className="text-xs text-muted-foreground">
              {doneFilter === 0 ? '未完成待办（按优先级+时间排序）' : '已完成待办'}
            </span>
            <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
              {(
                [
                  [0, '未完成'],
                  [1, '已完成'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onDoneFilterChange(k)}
                  className={cn(
                    'min-h-9 rounded-md px-3 text-xs transition-colors',
                    doneFilter === k
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground',
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="px-3">
            <MobileList
              items={todos}
              keyOf={(t) => t.id}
              loading={todosLoading}
              empty={
                <MobileEmptyState
                  icon={CheckCircle}
                  title={doneFilter === 0 ? '暂无未完成待办' : '暂无已完成待办'}
                  desc="任务指派 / 采购流转 / 交付催办都会汇总到这里"
                />
              }
              renderItem={(t) => (
                /* 待办行：优先级 chip + 标题（可跳转）+ 到期 + 完成/撤销（行内双操作，不嵌套 button） */
                <div key={t.id} className="flex min-h-14 items-center gap-2.5 px-4 py-2.5">
                  <MobileStatusChip
                    label={label(PRIORITY, t.priority)}
                    tone={PRIORITY_TONE[t.priority] ?? 'default'}
                  />
                  <button
                    type="button"
                    disabled={!t.link}
                    onClick={() => onTodoOpen(t)}
                    className={cn(
                      'min-w-0 flex-1 truncate text-left text-sm',
                      t.link
                        ? 'text-foreground active:text-primary'
                        : 'cursor-default text-foreground/90',
                    )}
                    title={t.title}
                  >
                    {t.title}
                  </button>
                  {t.dueAt && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {formatDate(t.dueAt)}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={togglingId === t.id}
                    onClick={() => onToggleTodo(t)}
                    className={cn(
                      'flex h-11 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs transition-colors',
                      doneFilter === 0
                        ? 'text-emerald-600 active:bg-emerald-500/10 dark:text-emerald-400'
                        : 'text-muted-foreground active:bg-muted/60',
                    )}
                  >
                    {doneFilter === 0 ? (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        完成
                      </>
                    ) : (
                      <>
                        <Undo2 className="h-4 w-4" />
                        撤销
                      </>
                    )}
                  </button>
                </div>
              )}
            />
          </div>
        </div>
      ) : (
        /* ── Tab 2：催办中心（三分区） ── */
        <div className="space-y-4">
          {urgesLoading ? (
            <div className="mx-3">
              <MobileList items={[]} keyOf={(i) => String(i)} loading renderItem={() => null} />
            </div>
          ) : (
            <>
              {/* 分区 1：催办我的（红色左边线强调，触控行点击进事务） */}
              <section className="space-y-2">
                <h4 className="flex items-center gap-2 px-4 pt-1 text-sm font-medium">
                  <BellRing
                    className={cn(
                      'h-4 w-4',
                      incoming.length > 0 ? 'text-destructive' : 'text-primary',
                    )}
                  />
                  催办我的
                  <MobileStatusChip
                    label={incoming.length > 0 ? `${incoming.length} 条待处理` : '暂无'}
                    tone={incoming.length > 0 ? 'danger' : 'default'}
                  />
                </h4>
                <div className="mx-3">
                  <MobileList
                    items={incoming}
                    keyOf={(u) => u.id}
                    empty={
                      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-sm text-muted-foreground">
                        <CheckCircle className="h-4 w-4 text-emerald-500" />
                        暂无被催办的交付文件
                      </div>
                    }
                    renderItem={(u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => onUrgeFile(u)}
                        className="flex w-full items-start gap-2.5 border-l-2 border-destructive px-4 py-3 text-left active:bg-muted/60"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                              {u.projectCode}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {u.requirementName}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {u.urgedBy?.name ?? '?'} 催办 · {formatRelativeTime(u.createdAt)}
                          </p>
                        </div>
                      </button>
                    )}
                  />
                </div>
              </section>

              {/* 分区 2：我催办的（撤回常显——移动端无 hover） */}
              <section className="space-y-2">
                <h4 className="flex items-center gap-2 px-4 pt-1 text-sm font-medium">
                  <Send className="h-4 w-4 text-amber-500" />
                  我催办的
                  <MobileStatusChip label={`${outgoing.length} 条`} tone="default" />
                </h4>
                <div className="mx-3">
                  <MobileList
                    items={outgoing}
                    keyOf={(u) => u.id}
                    empty={
                      <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-sm text-muted-foreground">
                        暂无我发起的催办
                      </div>
                    }
                    renderItem={(u) => (
                      <div key={u.id} className="flex min-h-14 items-center gap-2 px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => onUrgeFile(u)}
                          className="flex min-w-0 flex-1 flex-col text-left"
                          title="进入具体事务"
                        >
                          <span className="flex items-center gap-2">
                            <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                              {u.projectCode}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {u.requirementName}
                            </span>
                          </span>
                          <span className="mt-0.5 truncate text-xs text-muted-foreground">
                            催 {u.targetUser?.name ?? '?'} · {formatRelativeTime(u.createdAt)}
                          </span>
                        </button>
                        {/* 撤回催办（常显，触控 h-11 w-11） */}
                        <button
                          type="button"
                          aria-label={`撤回对 ${u.requirementName} 的催办`}
                          onClick={() => onDeleteUrge(u.id, u.requirementName)}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-destructive/10 active:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  />
                </div>
              </section>

              {/* 分区 3：最近已处理（闭环） */}
              {recentlyDone.length > 0 && (
                <section className="space-y-2">
                  <h4 className="flex items-center gap-2 px-4 pt-1 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    最近已处理
                  </h4>
                  <div className="mx-3">
                    <MobileList
                      items={recentlyDone}
                      keyOf={(u) => u.id}
                      renderItem={(u) => (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => onUrgeFile(u)}
                          className="flex w-full items-center gap-2.5 px-4 py-3 text-left active:bg-muted/60"
                        >
                          <CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                                {u.projectCode}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {u.requirementName}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {u.urgedBy?.name ?? '?'} 催办 · 已处理
                              {u.doneAt ? `（${formatRelativeTime(u.doneAt)}）` : ''}
                            </p>
                          </div>
                        </button>
                      )}
                    />
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
