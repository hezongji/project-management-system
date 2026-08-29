'use client'

/**
 * 阶段卡 —— §8.2① PhaseTree 阶段卡契约：
 *   状态色条（DONE绿/IN_PROGRESS蓝/WAITING[PAUSED]灰/PENDING[NOT_STARTED]默认/SKIPPED黄）
 *   进度环 / 负责人头像（首字 fallback）/ 计划实际日期 / 延误红标 / 文件徽章(approved/total)
 *   点击 → /projects/:id/phases/:phaseId 下钻（P1-4 路由，占位跳转）
 *   行内：[完成勾(权限)] [跳过(权限+备注弹窗)] [改派负责人] [删除(权限；有任务/文件时禁用+tooltip)]
 *   拖拽：canReorder 时可拖（同级排序由 PhaseTree 汇总落库）
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  Circle,
  SkipForward,
  UserRoundCog,
  FileCheck2,
  GripVertical,
  CalendarDays,
  AlertTriangle,
  ClipboardList,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProgressRing } from '@/components/projects/progress-ring'
import type { PhaseTreeNode } from '@/types/project-tree'
import { cn } from '@/lib/utils'

/** 日期 ISO → MM-DD 短显示 */
function short(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** §8.2① 状态色条映射 */
export const PHASE_STATUS_BAR: Record<PhaseTreeNode['status'], string> = {
  DONE: 'bg-green-500',
  IN_PROGRESS: 'bg-blue-500',
  PAUSED: 'bg-gray-400', // WAITING
  NOT_STARTED: 'bg-slate-300', // PENDING（默认）
  SKIPPED: 'bg-yellow-500',
}

export const PHASE_STATUS_TEXT: Record<PhaseTreeNode['status'], string> = {
  DONE: '已完成',
  IN_PROGRESS: '进行中',
  PAUSED: '暂停',
  NOT_STARTED: '未开始',
  SKIPPED: '已跳过',
}

export const PHASE_STATUS_BADGE: Record<PhaseTreeNode['status'], string> = {
  DONE: 'bg-green-100 text-green-700 hover:bg-green-100',
  IN_PROGRESS: 'bg-blue-100 text-blue-700 hover:bg-blue-100',
  PAUSED: 'bg-gray-100 text-gray-600 hover:bg-gray-100',
  NOT_STARTED: 'bg-slate-100 text-slate-500 hover:bg-slate-100',
  SKIPPED: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-100',
}

/** 首字 fallback 头像（无 avatar 时取姓名末字/首字） */
function OwnerAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const char = name ? name.trim().charAt(0) : '?'
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {char}
    </span>
  )
}

interface PhaseCardProps {
  phase: PhaseTreeNode
  projectId: string
  canEdit: boolean
  canReorder: boolean
  completing: boolean
  onComplete: (phase: PhaseTreeNode) => void
  onSkip: (phase: PhaseTreeNode) => void
  onAssign: (phase: PhaseTreeNode) => void
  onDelete: (phase: PhaseTreeNode) => void
  onDragStart: (e: React.DragEvent, index: number) => void
  onDragOver: (e: React.DragEvent, index: number) => void
  onDrop: (e: React.DragEvent, index: number) => void
  onDragEnd: () => void
  index: number
  dragging: boolean
  dropTarget: boolean
}

export function PhaseCard({
  phase,
  projectId,
  canEdit,
  canReorder,
  completing,
  onComplete,
  onSkip,
  onAssign,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  index,
  dragging,
  dropTarget,
}: PhaseCardProps) {
  const router = useRouter()

  const isDone = phase.status === 'DONE'
  const isSkipped = phase.status === 'SKIPPED'
  const filesAllApproved =
    phase.fileStats.total > 0 && phase.fileStats.approved === phase.fileStats.total
  // 引用保护前置：有子任务/文件条目时禁用删除（后端同样拒绝，文案一致）
  const blockingCount = phase.taskCount + phase.fileStats.total
  const hasChildren = blockingCount > 0

  return (
    <li
      draggable={canReorder}
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative list-none',
        canReorder && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        dropTarget && 'border-t-2 border-t-primary',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => router.push(`/projects/${projectId}/phases/${phase.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') router.push(`/projects/${projectId}/phases/${phase.id}`)
        }}
        className="flex cursor-pointer items-stretch overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* 状态色条（§8.2①） */}
        <div className={cn('w-1.5 shrink-0', PHASE_STATUS_BAR[phase.status])} aria-hidden />

        <div className="flex flex-1 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
          {/* 拖拽把手（仅 OWNER/ADMIN） */}
          {canReorder && (
            <GripVertical className="hidden h-5 w-5 shrink-0 text-muted-foreground/40 sm:block" />
          )}

          {/* 序号 + 名称 + 状态 + 负责人 + 日期（单行排布） */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-x-4 gap-y-1 overflow-hidden">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{phase.code}</span>
              <span className="truncate font-medium">{phase.name}</span>
              <Badge variant="secondary" className={cn('shrink-0 px-1.5 py-0 text-xs', PHASE_STATUS_BADGE[phase.status])}>
                {PHASE_STATUS_TEXT[phase.status]}
              </Badge>
              {/* 延误红标（§8.2①：plannedEnd<今天且未DONE，服务端 delayed 字段） */}
              {phase.delayed && !isDone && (
                <Badge variant="destructive" className="shrink-0 gap-1 px-1.5 py-0 text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  延误
                </Badge>
              )}

              {/* 负责人 */}
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {phase.owner ? (
                  <>
                    <OwnerAvatar name={phase.owner.name} size={20} />
                    {phase.owner.name}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <UserRoundCog className="h-3.5 w-3.5" />
                    待分配
                  </span>
                )}
              </span>

              {/* 日期 */}
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                计划 {short(phase.plannedStart)} ~ {short(phase.plannedEnd)}
                {phase.actualEnd && (
                  <span className="text-green-600">· 实际完成 {short(phase.actualEnd)}</span>
                )}
              </span>
            </div>
          </div>

          {/* 任务计数 */}
          <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title="任务完成数 / 总数">
            <ClipboardList className="h-3.5 w-3.5" />
            {phase.taskDone}/{phase.taskCount}
          </div>

          {/* 文件徽章（approved/total） */}
          <div
            className="flex shrink-0 items-center gap-1.5 text-xs"
            title={`文件条目 ${phase.fileStats.approved} 通过 / ${phase.fileStats.total} 总计`}
          >
            <FileCheck2
              className={cn(
                'h-3.5 w-3.5',
                phase.fileStats.total === 0
                  ? 'text-muted-foreground/40'
                  : filesAllApproved
                    ? 'text-green-600'
                    : 'text-amber-600',
              )}
            />
            <span className={cn(filesAllApproved ? 'text-green-700' : 'text-amber-700')}>
              {phase.fileStats.approved}/{phase.fileStats.total}
            </span>
          </div>

          {/* 进度环 */}
          <ProgressRing value={phase.progress} size={40} />

          {/* 行内操作（权限显隐，点击不冒泡触发下钻；删除不受状态限制，DONE/SKIPPED 空阶段也可删） */}
          {canEdit && (
            <div
              className="flex shrink-0 items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {!isDone && !isSkipped && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-green-600 hover:text-green-700"
                    title="标记阶段完成（需全部任务完成且检查项全勾）"
                    disabled={completing}
                    onClick={() => onComplete(phase)}
                  >
                    {completing ? (
                      <Circle className="h-4 w-4 animate-pulse" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-yellow-600 hover:text-yellow-700"
                    title="跳过阶段（必填原因）"
                    onClick={() => onSkip(phase)}
                  >
                    <SkipForward className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="改派负责人"
                    onClick={() => onAssign(phase)}
                  >
                    <UserRoundCog className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                title={
                  hasChildren
                    ? `该阶段存在 ${blockingCount} 条任务/文件，请先清理或直接删除项目`
                    : '删除阶段（不可恢复）'
                }
                disabled={hasChildren}
                onClick={() => onDelete(phase)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
