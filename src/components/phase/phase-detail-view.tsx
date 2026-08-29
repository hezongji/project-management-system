'use client'

/**
 * 阶段下钻页（§8.2② 四区布局）
 *
 * ┌────────────────────────────────────────────┐
 * │ 头：阶段名+状态+负责人+计划/实际日期+检查项勾选区 │
 * ├──────────────────────────┬─────────────────┤
 * │ 左：任务看板四列（拖拽换列） │ 右：文件条目列表    │
 * ├──────────────────────────┴─────────────────┤
 * │ 底：该阶段动态（ActivityLog 过滤）              │
 * └────────────────────────────────────────────┘
 *
 * 数据源 GET /api/phases/:id（§7.5 下钻聚合）；
 * 状态/负责人/日期/checklist 勾选 → PATCH /api/phases/:id（阶段 edit 权限驱动显隐）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import {
  CalendarRange,
  CheckCircle2,
  CircleSlash,
  Flag,
  ListChecks,
  User,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { TaskKanban } from '@/components/phase/task-kanban'
import { FileRequirementList } from '@/components/phase/file-requirement-list'
import { PhaseActivityTimeline } from '@/components/phase/phase-activity'
import { PhaseService } from '@/services/phase'
import { useFocusHighlight } from '@/hooks/use-focus-highlight'
import type { ChecklistItem, PhaseMemberDto, PhaseStatus } from '@/types/phase'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/utils'

const PHASE_STATUS: Record<PhaseStatus, { label: string; cls: string }> = {
  NOT_STARTED: { label: '未开始', cls: 'bg-slate-100 text-slate-600' },
  IN_PROGRESS: { label: '进行中', cls: 'bg-blue-100 text-blue-700' },
  DONE: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700' },
  SKIPPED: { label: '已跳过', cls: 'bg-zinc-200 text-zinc-500' },
  PAUSED: { label: '已暂停', cls: 'bg-amber-100 text-amber-700' },
}

const DATE_FIELDS = [
  { key: 'plannedStart', label: '计划开始' },
  { key: 'plannedEnd', label: '计划结束' },
  { key: 'actualStart', label: '实际开始' },
  { key: 'actualEnd', label: '实际结束' },
] as const

type DateFieldKey = (typeof DATE_FIELDS)[number]['key']

/** checklist Json → ChecklistItem[]（非法结构容错） */
function normalizeChecklist(raw: unknown): ChecklistItem[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr.flatMap(item => {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const o = item as Record<string, unknown>
      return [
        {
          text: String(o.text ?? ''),
          checked: o.checked === true,
          checkedBy: typeof o.checkedBy === 'string' ? o.checkedBy : null,
          checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : null,
        },
      ]
    }
    return []
  })
}

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : ''
}

export default function PhaseDetailView({
  projectId,
  phaseId,
}: {
  projectId: string
  phaseId: string
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { focusId, srcLabel, clearFocus } = useFocusHighlight()

  const { data, isLoading, error } = useQuery({
    queryKey: ['phase-detail', phaseId],
    queryFn: () => PhaseService.getPhaseDetail(phaseId),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['phase-detail', phaseId] })

  const statusMutation = useMutation({
    mutationFn: (status: PhaseStatus) =>
      PhaseService.updatePhaseStatus(phaseId, status),
    onSuccess: () => invalidate(),
    onError: (e: Error) =>
      toast({
        title: '状态更新失败',
        description: e.message,
        variant: 'destructive',
      }),
  })

  const checklistMutation = useMutation({
    mutationFn: (p: { index: number; checked: boolean }) =>
      PhaseService.toggleChecklistItem(phaseId, p.index, p.checked),
    onSuccess: () => invalidate(),
    onError: (e: Error) =>
      toast({
        title: '勾选失败',
        description: e.message,
        variant: 'destructive',
      }),
  })

  const ownerMutation = useMutation({
    mutationFn: (ownerId: string) =>
      PhaseService.updatePhaseOwner(phaseId, ownerId),
    onSuccess: () => {
      invalidate()
      toast({ title: '阶段负责人已更新' })
    },
    onError: (e: Error) =>
      toast({
        title: '改派失败',
        description: e.message,
        variant: 'destructive',
      }),
  })

  const dateMutation = useMutation({
    mutationFn: (dates: Partial<Record<DateFieldKey, string | null>>) =>
      PhaseService.updatePhaseDates(phaseId, dates),
    onSuccess: () => invalidate(),
    onError: (e: Error) =>
      toast({
        title: '日期更新失败',
        description: e.message,
        variant: 'destructive',
      }),
  })

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error || !data?.data) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
            <CircleSlash className="h-6 w-6" />
            <span>
              {error instanceof Error ? error.message : '阶段不存在或无权访问'}
            </span>
            <Button variant="outline" size="sm" asChild>
              <Link href="/projects">返回项目列表</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const detail = data.data
  const { phase, project, permissions, canMarkDone, members } = detail
  const canEdit = permissions.edit
  const statusMeta = PHASE_STATUS[phase.status] ?? PHASE_STATUS.NOT_STARTED
  const checklist = normalizeChecklist(phase.checklist)
  const checkedCount = checklist.filter(c => c.checked).length
  const memberNameOf = (uid: string | null) =>
    uid
      ? (members.find((m: PhaseMemberDto) => m.userId === uid)?.name ?? null)
      : null

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* ─────────── 头区：阶段名 + 状态 + 负责人 + 日期 + checklist ─────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link
                href="/projects"
                className="hover:text-foreground hover:underline"
              >
                项目
              </Link>
              <span>/</span>
              <span className="font-mono">{project.code}</span>
              <span>/</span>
              <span className="max-w-[12em] truncate">{project.name}</span>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex items-center gap-2 text-xl">
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-sm">
                {phase.code}
              </span>
              {phase.name}
            </CardTitle>
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                statusMeta.cls
              )}
            >
              {statusMeta.label}
            </span>

            {canEdit &&
            phase.status !== 'DONE' &&
            phase.status !== 'SKIPPED' ? (
              <Select
                value={phase.status}
                onValueChange={v => statusMutation.mutate(v as PhaseStatus)}
              >
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue placeholder="变更状态" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      'NOT_STARTED',
                      'IN_PROGRESS',
                      'PAUSED',
                      'DONE',
                    ] as PhaseStatus[]
                  )
                    .filter(s => s !== 'SKIPPED')
                    .map(s => (
                      <SelectItem key={s} value={s} className="text-xs">
                        {PHASE_STATUS[s].label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : null}

            {canEdit &&
              phase.status !== 'DONE' &&
              phase.status !== 'SKIPPED' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={statusMutation.isPending || !canMarkDone.ok}
                  title={canMarkDone.ok ? '标记阶段完成' : canMarkDone.reason}
                  onClick={() => statusMutation.mutate('DONE')}
                >
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  标记完成
                </Button>
              )}

            {phase.status === 'SKIPPED' && phase.skippedNote && (
              <span className="text-xs text-muted-foreground">
                跳过原因：{phase.skippedNote}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            {/* 负责人（阶段 edit 可改派；改派后自动并入项目成员） */}
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">负责人</span>
              {canEdit ? (
                <Select
                  value={phase.ownerId ?? undefined}
                  onValueChange={v => ownerMutation.mutate(v)}
                >
                  <SelectTrigger className="h-8 w-[160px] text-xs">
                    <SelectValue placeholder="未分配" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((m: PhaseMemberDto) => (
                      <SelectItem
                        key={m.userId}
                        value={m.userId}
                        className="text-xs"
                      >
                        {m.name}
                        {m.title ? `（${m.title}）` : ''}
                        {m.isPhaseOwner ? ' · 当前' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="font-medium">
                  {phase.owner?.name ?? (
                    <span className="italic text-muted-foreground">未分配</span>
                  )}
                  {phase.owner?.jobTitle ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {phase.owner.jobTitle}
                    </span>
                  ) : null}
                </span>
              )}
            </div>

            {/* 计划/实际日期（阶段 edit 可改） */}
            <div className="flex items-center gap-2">
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
              {DATE_FIELDS.map(f => {
                const value = phase[f.key]
                return (
                  <span key={f.key} className="flex items-center gap-1 text-xs">
                    <span className="text-muted-foreground">{f.label}</span>
                    {canEdit ? (
                      <input
                        type="date"
                        className="h-7 rounded-md border bg-transparent px-1.5 text-xs"
                        value={toDateInputValue(value)}
                        onChange={e =>
                          dateMutation.mutate({
                            [f.key]: e.target.value || null,
                          } as Partial<Record<DateFieldKey, string | null>>)
                        }
                      />
                    ) : (
                      <span>{value ? formatDate(value) : '—'}</span>
                    )}
                  </span>
                )
              })}
            </div>

            {/* 进度（phase-engine 自动回写） */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">进度</span>
              <div className="h-2 w-32 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${phase.progress}%` }}
                />
              </div>
              <span className="text-xs font-semibold">{phase.progress}%</span>
            </div>
          </div>

          {/* 跨页定位来源提示（?src= 通知/消息卡片/待办等；关闭同时清除 focus 参数） */}
          {srcLabel && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
              <Badge variant="default" className="h-5 px-2 text-[11px]">
                已定位任务 · 来自：{srcLabel}
              </Badge>
              <span className="text-muted-foreground">已在下方看板中高亮对应任务卡</span>
              <button
                type="button"
                onClick={clearFocus}
                className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="关闭定位提示"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* 检查项勾选区（PATCH checklist；全勾+任务全 DONE → 引擎自动置 DONE） */}
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">验收检查项</span>
              {checklist.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {checkedCount}/{checklist.length}
                </Badge>
              )}
            </div>
            {checklist.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                本阶段无检查项（checklist 为空视为满足完成条件）
              </div>
            ) : (
              <ul className="space-y-1.5">
                {checklist.map((item, index) => (
                  <li key={index} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={item.checked}
                      disabled={!canEdit || checklistMutation.isPending}
                      onCheckedChange={v =>
                        checklistMutation.mutate({ index, checked: v === true })
                      }
                      aria-label={item.text}
                    />
                    <span
                      className={cn(
                        item.checked && 'text-muted-foreground line-through'
                      )}
                    >
                      {item.text}
                    </span>
                    {item.checked && item.checkedAt && (
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {memberNameOf(item.checkedBy) ?? '—'} ·{' '}
                        {formatDate(item.checkedAt)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─────────── 左区：任务看板 ｜ 右区：文件条目 ─────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[420px]">
          <CardContent className="h-full pt-6">
            <TaskKanban
              phaseId={phaseId}
              projectId={projectId}
              columns={detail.taskColumns}
              cancelledTasks={detail.cancelledTasks}
              focusId={focusId}
            />
          </CardContent>
        </Card>
        <Card className="min-h-[420px]">
          <CardContent className="h-full pt-6">
            <FileRequirementList requirements={detail.fileRequirements} />
          </CardContent>
        </Card>
      </div>

      {/* ─────────── 底区：该阶段动态 ─────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Flag className="h-4 w-4 text-muted-foreground" />
            阶段动态
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PhaseActivityTimeline activities={detail.activities} />
        </CardContent>
      </Card>
    </div>
  )
}
