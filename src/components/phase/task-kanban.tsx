'use client'

/**
 * 任务看板（阶段下钻页左区，§8.2②）
 *
 * 四列 TODO / IN_PROGRESS / REVIEW / DONE（CANCELLED 不进看板，底部折叠提示）。
 * 卡片含 assignee / 修订数(v{revision}) / 标注数 / 评论数；
 * 点击卡片 → /projects/:projectId/tasks/:taskId（任务详情抽屉，P1-5 交付，
 * 当前为占位路由）；拖拽换列 → PATCH /api/tasks/:id { status }（§7.6），
 * 服务端经 phase-engine.onTaskChanged 完成 §7.5 联动（自动进行中/完成/催办/进度）。
 */

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core'
import {
  Bookmark,
  Calendar,
  GripVertical,
  History,
  MessageSquare,
  Undo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/utils'
import { PhaseService } from '@/services/phase'
import type { PhaseTaskCard, TaskStatus } from '@/types/phase'
import { useToast } from '@/components/ui/use-toast'
import { FocusRing } from '@/components/ui/focus-ring'

const COLUMNS: { key: Exclude<TaskStatus, 'CANCELLED'>; label: string; dot: string }[] = [
  { key: 'TODO', label: '待办', dot: 'bg-slate-400' },
  { key: 'IN_PROGRESS', label: '进行中', dot: 'bg-blue-500' },
  { key: 'REVIEW', label: '待审核', dot: 'bg-amber-500' },
  { key: 'DONE', label: '已完成', dot: 'bg-emerald-500' },
]

const PRIORITY_DOT: Record<string, string> = {
  LOW: 'bg-slate-300',
  MEDIUM: 'bg-blue-400',
  HIGH: 'bg-orange-400',
  URGENT: 'bg-red-500',
}

interface TaskKanbanProps {
  phaseId: string
  projectId: string
  columns: Record<Exclude<TaskStatus, 'CANCELLED'>, PhaseTaskCard[]>
  cancelledTasks: PhaseTaskCard[]
  /** 跨页定位：命中的任务卡滚动到视图并闪烁高亮（来自 ?focus=<taskId>） */
  focusId?: string | null
}

export function TaskKanban({ phaseId, projectId, columns, cancelledTasks, focusId }: TaskKanbanProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  // distance=8：区分「点击开卡」与「拖拽换列」两种手势
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const taskIndex = useMemo(() => {
    const map = new Map<string, PhaseTaskCard>()
    for (const col of Object.values(columns)) for (const t of col) map.set(t.id, t)
    return map
  }, [columns])

  const moveMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      PhaseService.updateTaskStatus(taskId, status),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['phase-detail', phaseId] })
      toast({ title: '任务已移列', description: `${taskIndex.get(variables.taskId)?.title ?? ''} → ${COLUMNS.find((c) => c.key === variables.status)?.label ?? variables.status}` })
    },
    onError: (error: Error) => {
      toast({ title: '移动失败', description: error.message, variant: 'destructive' })
    },
  })

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = String(active.id)
    const targetStatus = String(over.id) as TaskStatus
    const task = taskIndex.get(taskId)
    if (!task || task.status === targetStatus || targetStatus === 'CANCELLED') return
    moveMutation.mutate({ taskId, status: targetStatus })
  }

  const total = Object.values(columns).reduce((acc, col) => acc + col.length, 0)

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">任务看板（{total}）</h2>
        <span className="text-xs text-muted-foreground">拖动卡片换列 · 点击打开任务</span>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <BoardColumn
              key={col.key}
              columnKey={col.key}
              label={col.label}
              dot={col.dot}
              tasks={columns[col.key]}
              dragging={moveMutation.isPending}
              focusId={focusId}
              onOpenTask={(taskId) => router.push(`/projects/${projectId}/tasks/${taskId}`)}
            />
          ))}
        </div>
      </DndContext>

      {cancelledTasks.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Undo2 className="h-3.5 w-3.5" />
          <span>已取消（不进看板）：</span>
          {cancelledTasks.map((t) => (
            <FocusRing key={t.id} id={t.id} focusId={focusId}>
              <span className="rounded bg-muted px-1.5 py-0.5 line-through">
                {t.title}
              </span>
            </FocusRing>
          ))}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── 看板列 ─────────────────────────────

interface BoardColumnProps {
  columnKey: Exclude<TaskStatus, 'CANCELLED'>
  label: string
  dot: string
  tasks: PhaseTaskCard[]
  dragging: boolean
  focusId?: string | null
  onOpenTask: (taskId: string) => void
}

function BoardColumn({ columnKey, label, dot, tasks, dragging, focusId, onOpenTask }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: columnKey })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-h-[220px] flex-col rounded-lg border bg-muted/30 p-2 transition-colors',
        isOver && 'border-primary/60 bg-primary/5',
      )}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        <span className="text-xs font-semibold">{label}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
          {tasks.length}
        </span>
      </div>
      <div className={cn('flex flex-1 flex-col gap-2', dragging && 'pointer-events-none')}>
        {tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed py-6 text-[11px] text-muted-foreground">
            拖任务到此列
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} task={task} focusId={focusId} onOpen={() => onOpenTask(task.id)} />
          ))
        )}
      </div>
    </div>
  )
}

// ───────────────────────────── 任务卡 ─────────────────────────────

interface TaskCardProps {
  task: PhaseTaskCard
  focusId?: string | null
  onOpen: () => void
}

function TaskCard({ task, focusId, onOpen }: TaskCardProps) {
  const draggable = useDraggable({ id: task.id, disabled: !task.permissions.edit })
  const canDrag = task.permissions.edit

  return (
    <FocusRing id={task.id} focusId={focusId}>
      <div
        ref={draggable.setNodeRef}
      {...draggable.listeners}
      {...draggable.attributes}
      role="button"
      tabIndex={0}
      onClick={() => {
        // PointerSensor distance=8：拖拽超过阈值后 click 不触发（dnd-kit 拦截）
        if (!draggable.isDragging) onOpen()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      className={cn(
        'group cursor-pointer rounded-md border bg-background p-2.5 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        draggable.isDragging && 'opacity-50',
      )}
      aria-label={`任务：${task.title}`}
    >
      <div className="flex items-start gap-1.5">
        {canDrag && (
          <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[task.priority] ?? 'bg-slate-300')} />
            <span className="truncate text-sm font-medium">{task.title}</span>
          </div>

          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            {task.assignee ? (
              <span className="inline-flex items-center gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {task.assignee.name.slice(0, 1)}
                </span>
                <span className="max-w-[6em] truncate">{task.assignee.name}</span>
              </span>
            ) : (
              <span className="italic opacity-70">未指派</span>
            )}

            <span className="inline-flex items-center gap-0.5" title={`版本 v${task.revision} / ${task._count.revisions} 次修订`}>
              <History className="h-3 w-3" />v{task.revision}
            </span>
            {task._count.annotations > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${task._count.annotations} 条标注`}>
                <Bookmark className="h-3 w-3" />
                {task._count.annotations}
              </span>
            )}
            {task._count.comments > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${task._count.comments} 条评论`}>
                <MessageSquare className="h-3 w-3" />
                {task._count.comments}
              </span>
            )}
            {task.dueDate && (
              <span className="ml-auto inline-flex items-center gap-0.5" title={`截止 ${task.dueDate.slice(0, 10)}`}>
                <Calendar className="h-3 w-3" />
                {formatRelativeTime(task.dueDate).replace('前', '前截止')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
    </FocusRing>
  )
}
