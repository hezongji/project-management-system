'use client'

/**
 * 阶段动态时间线（阶段下钻页底区，§8.2②）
 *
 * ActivityLog 过滤 phaseId/phaseCode 后的最近 50 条。
 * action → 中文动作映射；detail.changes → 字段级变更摘要。
 */

import { Activity } from 'lucide-react'
import { formatRelativeTime } from '@/lib/utils'
import type { PhaseActivityDto } from '@/types/phase'

const ACTION_LABEL: Record<string, string> = {
  'phase.update': '更新了阶段',
  'phase.done': '完成了阶段',
  'phase.skip': '跳过了阶段',
  'task.status_change': '变更了任务状态',
  'task.create': '创建了任务',
  'task.update': '更新了任务',
  'task.revision': '修订了任务',
  'task.rollback': '回滚了任务版本',
  'file.submit': '提交了文件',
  'file.approve': '通过了文件',
  'file.reject': '驳回了文件',
}

/** 状态枚举 → 中文（任务/阶段状态变更展示用） */
const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  REVIEW: '待审核',
  DONE: '已完成',
  CANCELLED: '已取消',
  TODO: '待办',
  PAUSED: '已暂停',
  SKIPPED: '已跳过',
}

function describeChange(detail: Record<string, unknown> | null): string | null {
  if (!detail || typeof detail !== 'object') return null
  const changes = (detail as { changes?: unknown }).changes
  if (!changes || typeof changes !== 'object') return null

  const parts: string[] = []
  for (const [field, value] of Object.entries(changes as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length === 2) {
      const [from, to] = value as [unknown, unknown]
      if (field === 'status') {
        parts.push(
          `状态 ${STATUS_LABEL[String(from)] ?? from} → ${STATUS_LABEL[String(to)] ?? to}`,
        )
      } else {
        parts.push(`${field}: ${String(from ?? '—')} → ${String(to ?? '—')}`)
      }
    } else if (field === 'checklist' && value && typeof value === 'object') {
      const c = value as { text?: unknown; to?: unknown }
      if (c.to === true) parts.push(`勾选检查项「${String(c.text ?? '')}」`)
      else parts.push(`取消检查项「${String(c.text ?? '')}」`)
    }
  }
  return parts.length > 0 ? parts.join('；') : null
}

function describeTarget(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null
  const title = (detail as { taskTitle?: unknown }).taskTitle
  if (typeof title === 'string') return title
  const phaseName = (detail as { phaseName?: unknown }).phaseName
  if (typeof phaseName === 'string') return null // 本阶段自身动态无需重复阶段名
  return null
}

interface PhaseActivityTimelineProps {
  activities: PhaseActivityDto[]
}

export function PhaseActivityTimeline({ activities }: PhaseActivityTimelineProps) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">阶段动态（{activities.length}）</h2>
      </div>

      {activities.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          暂无动态（阶段更新 / 任务状态变更 / 检查项勾选会记录在此）
        </div>
      ) : (
        <ol className="relative ml-3 space-y-4 border-l">
          {activities.map((log) => {
            const change = describeChange(log.detail)
            const target = describeTarget(log.detail)
            return (
              <li key={log.id} className="relative pl-5">
                <span className="absolute -left-[9px] top-1 flex h-4 w-4 items-center justify-center rounded-full bg-muted">
                  <Activity className="h-2.5 w-2.5 text-muted-foreground" />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{log.user.name}</span>
                  <span className="text-muted-foreground">
                    {ACTION_LABEL[log.action] ?? log.action}
                  </span>
                  {target && (
                    <span className="rounded bg-muted px-1.5 text-xs">「{target}」</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelativeTime(log.createdAt)}
                  </span>
                </div>
                {change && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{change}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
