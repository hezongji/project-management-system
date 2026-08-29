'use client'

/**
 * 修订历史时间线 —— 《开发文档-项目管理系统重构》§8.2③
 * 任务抽屉「修订历史」区：时间线 + 字段 diff 高亮（旧值删除线红 / 新值绿）+ 回滚按钮。
 *
 * diff 语义：每条修订记录的 snapshot = 该版本（version=修订前 revision）时刻的状态；
 * 「本次修订改了什么」= snapshot(version=N) 与 snapshot(version=N+1)（或任务当前值，对最新一条）比较。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/services/api-instance'
import { useToast } from '@/components/ui/use-toast'
import {
  History,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  User as UserIcon,
} from 'lucide-react'
import { globalConfirm } from '@/lib/global-confirm'
import {
  TaskDetail,
  TaskSnapshot,
  FIELD_LABELS,
  displaySnapshotValue,
} from './types'

interface RevisionDiff {
  field: string
  oldVal: unknown
  newVal: unknown
}

/** snapshot N → snapshot N+1 的字段级差异 */
function diffBetween(a: TaskSnapshot, b: TaskSnapshot): RevisionDiff[] {
  const out: RevisionDiff[] = []
  const keys: (keyof TaskSnapshot)[] = [
    'title',
    'description',
    'status',
    'priority',
    'assigneeId',
    'dueDate',
  ]
  for (const k of keys) {
    if (a[k] !== b[k]) out.push({ field: k, oldVal: a[k], newVal: b[k] })
  }
  return out
}

/** 任务当前六字段快照（与最新修订比较用） */
function currentSnapshotOf(task: TaskDetail): TaskSnapshot {
  return {
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId ?? null,
    dueDate: task.dueDate ?? null,
  }
}

export function RevisionTimeline({
  task,
  onMutated,
}: {
  task: TaskDetail
  onMutated: () => void
}) {
  const { toast } = useToast()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [rollingBack, setRollingBack] = useState<number | null>(null)

  const candidates = [
    ...(task.mentionCandidates ?? []),
    ...(task.assignee ? [task.assignee] : []),
    ...(task.creator ? [task.creator] : []),
  ]

  const canEdit = task.permissions?.edit === true && !task.project.isArchived
  const revisions = [...(task.revisions ?? [])].sort((a, b) => b.version - a.version)

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRollback = async (version: number) => {
    if (!(await globalConfirm(`确认回滚到版本 v${version}？将先生成一条新修订记录快照当前值。`))) return
    setRollingBack(version)
    try {
      const res = await api.post(`/tasks/${task.id}/revisions/${version}/rollback`)
      toast({ title: '回滚成功', description: res.data?.message })
      onMutated()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '回滚失败', description: msg, variant: 'destructive' })
    } finally {
      setRollingBack(null)
    }
  }

  if (revisions.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        暂无修订记录（当前 v{task.revision}）——重大变更时通过「发起修订」留痕
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {revisions.map((rev, idx) => {
        // 该修订的「改后状态」= 下一个更低版本的快照；最新一条则与任务当前值比
        const older = revisions[idx + 1]
        const afterSnap: TaskSnapshot = older
          ? older.snapshot
          : currentSnapshotOf(task)
        const diffs = diffBetween(rev.snapshot, afterSnap)
        const isOpen = expanded.has(rev.id)
        return (
          <div key={rev.id} className="relative pl-6">
            {/* 时间线轴与节点 */}
            <span className="absolute left-[7px] top-6 bottom-0 w-px bg-border" aria-hidden />
            <span
              className="absolute left-0 top-1.5 h-[15px] w-[15px] rounded-full border-2 border-primary bg-background"
              aria-hidden
            />
            <div className="pb-5">
              <button
                type="button"
                onClick={() => toggle(rev.id)}
                className="flex w-full items-start justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-primary">v{rev.version}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <UserIcon className="h-3 w-3" />
                      {rev.changedBy?.name ?? '—'}
                      <span className="ml-1">
                        {new Date(rev.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </span>
                    </span>
                    {diffs.length > 0 && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {diffs.length} 处变更
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm">{rev.changeSummary}</p>
                </div>
                <span className="mt-1 shrink-0 text-muted-foreground">
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              </button>

              {isOpen && (
                <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
                  {diffs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">（该版本与后一版本无字段差异）</p>
                  ) : (
                    diffs.map((d) => (
                      <div key={d.field} className="text-sm">
                        <span className="mr-2 text-xs font-medium text-muted-foreground">
                          {FIELD_LABELS[d.field] ?? d.field}
                        </span>
                        <span className="mr-1 inline-flex max-w-full items-center">
                          <del className="rounded bg-red-50 px-1.5 py-0.5 text-red-600 dark:bg-red-950/40 dark:text-red-400">
                            {displaySnapshotValue(d.field, d.oldVal, candidates)}
                          </del>
                          <span className="mx-1 text-muted-foreground">→</span>
                          <ins className="rounded bg-green-50 px-1.5 py-0.5 no-underline text-green-700 dark:bg-green-950/40 dark:text-green-400">
                            {displaySnapshotValue(d.field, d.newVal, candidates)}
                          </ins>
                        </span>
                      </div>
                    ))
                  )}
                  <div className="flex items-center justify-between pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      快照于 v{rev.version}（修订前状态）
                    </span>
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rollingBack !== null}
                        onClick={() => handleRollback(rev.version)}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        {rollingBack === rev.version ? '回滚中…' : `回滚到此版本`}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
      <div className="pl-6 text-xs text-muted-foreground">
        <History className="mr-1 inline h-3 w-3" />
        当前 v{task.revision}（创建为 v1，每次修订/回滚 +1）
      </div>
    </div>
  )
}
