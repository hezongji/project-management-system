'use client'

/**
 * MobileDashboard —— 工作台移动子树（375-430px 微信式卡片流）。
 * 数据全部由页面传入（复用页面 useQuery 缓存，不重复请求）；桌面 JSX 原样保留在页面内。
 */

import { useRouter } from 'next/navigation'
import {
  Activity,
  ArrowRight,
  BarChart3,
  BellRing,
  Calendar,
  CheckCircle,
  Clock,
  FileUp,
  FolderKanban,
  ListTodo,
  Plus,
  Send,
  Target,
  AlertTriangle,
  Trash2,
} from 'lucide-react'
import { MobileCard } from './card'
import { MobileList, MobileListItem } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { cn, formatDate, formatRelativeTime } from '@/lib/utils'
import { label, PROJECT_STATUS, PRIORITY } from '@/lib/labels'
import type { Project } from '@/types'
import type { MyDeliverableItem } from '@/types/files'

/* ── 数据形状（与页面查询契约对齐，宽松视图层类型） ── */
interface UpcomingTask {
  id: string
  title: string
  dueDate: string
  priority: string
  project: { id: string; code: string; name: string }
}
interface RecentActivity {
  id: string
  type: string
  title: string
  description: string
  timestamp: string
  project?: { id: string; code: string; name: string } | null
}
interface UrgeIncoming {
  id: string
  projectId: string
  projectCode: string
  requirementId: string
  requirementName: string
  urgedBy: { name: string }
  createdAt: string
}
interface UrgeOutgoing {
  id: string
  projectId: string
  projectCode: string
  requirementId: string
  requirementName: string
  targetUser: { name: string }
  createdAt: string
}
interface UrgeDone {
  id: string
  projectCode: string
  requirementName: string
  urgedBy: { name: string }
  doneAt: string
}
interface TodoItem {
  id: string
  title: string
  sourceType: string
  link?: string | null
  dueAt?: string | null
  priority: string
}
export interface MobileDashboardProps {
  userName?: string | null
  stats?: {
    totalProjects: number
    activeProjects: number
    completedProjects: number
    totalTasks: number
    completedTasks: number
    overdueTasks: number
    upcomingTasks: UpcomingTask[]
    recentActivities: RecentActivity[]
  }
  taskDoneRate: number
  projects: Project[]
  projectsLoading: boolean
  deliverables: MyDeliverableItem[]
  deliverablesTotal: number
  myStats: { waiting: number; submitted: number; rejected: number; overdue: number }
  urges?: {
    incoming: UrgeIncoming[]
    incomingCount: number
    outgoing: UrgeOutgoing[]
    outgoingCount: number
    recentlyDone: UrgeDone[]
  }
  todos: TodoItem[]
  canCreate: boolean
  onDeleteTodo: (id: string, title: string) => void
  onDeleteUrge: (id: string, name: string) => void
  onUrgeFile: (projectId: string, requirementId: string) => void
}

const PRIORITY_TONE: Record<string, MobileChipTone> = {
  URGENT: 'danger',
  HIGH: 'danger',
  MEDIUM: 'default',
  LOW: 'default',
}
const PROJECT_TONE: Record<string, MobileChipTone> = {
  ACTIVE: 'info',
  COMPLETED: 'success',
  ON_HOLD: 'warning',
  CANCELLED: 'danger',
}

export function MobileDashboard(props: MobileDashboardProps) {
  const router = useRouter()
  const {
    userName, stats, taskDoneRate, projects, projectsLoading,
    deliverables, deliverablesTotal, myStats, urges, todos, canCreate,
    onDeleteTodo, onDeleteUrge, onUrgeFile,
  } = props
  const s = stats
  const upcomingTasks = s?.upcomingTasks ?? []
  const recentActivities = s?.recentActivities ?? []
  const urgeIncoming = urges?.incomingCount ?? 0
  const urgeOutgoing = urges?.outgoingCount ?? 0

  const goTodo = (t: TodoItem) => {
    if (!t.link) return
    const target = t.link.includes('src=')
      ? t.link
      : t.link + (t.link.includes('?') ? '&' : '?') + 'src=' + encodeURIComponent('待办')
    router.push(target.startsWith('/') ? target : '/')
  }

  /* 统计横滑卡（5 张，点击跳转与桌面一致） */
  const statCards: Array<{
    title: string; value: number; desc: string; icon: typeof FolderKanban
    toneCls: string; onClick: () => void
  }> = [
    {
      title: '总项目数', value: s?.totalProjects ?? 0,
      desc: (s?.activeProjects ?? 0) + ' 进行中 · ' + (s?.completedProjects ?? 0) + ' 已完成',
      icon: FolderKanban, toneCls: 'text-primary',
      onClick: () => router.push('/projects'),
    },
    {
      title: '总任务数', value: s?.totalTasks ?? 0,
      desc: (s?.completedTasks ?? 0) + ' 已完成（完成率 ' + taskDoneRate + '%）',
      icon: Target, toneCls: 'text-emerald-600 dark:text-emerald-300',
      onClick: () => router.push('/tasks'),
    },
    {
      title: '逾期任务', value: s?.overdueTasks ?? 0,
      desc: '未完成且已过截止日期',
      icon: AlertTriangle,
      toneCls: (s?.overdueTasks ?? 0) > 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-300',
      onClick: () => router.push('/tasks'),
    },
    {
      title: '我的待提交', value: myStats.waiting + myStats.rejected,
      desc: myStats.overdue + ' 逾期 · ' + myStats.submitted + ' 已提交',
      icon: FileUp,
      toneCls: (myStats.overdue ?? 0) > 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-300',
      onClick: () => router.push('/files?mine=1'),
    },
    {
      title: '我的催办',
      value: urgeIncoming > 0 ? urgeIncoming : urgeOutgoing,
      desc: urgeIncoming > 0
        ? urgeIncoming + ' 条催办我的 · ' + urgeOutgoing + ' 条我催办的'
        : '我催办 ' + urgeOutgoing + ' 条',
      icon: BellRing,
      toneCls: urgeIncoming > 0 ? 'text-destructive' : 'text-amber-600 dark:text-amber-300',
      onClick: () => router.push('/todos?src=' + encodeURIComponent('催办')),
    },
  ]

  return (
    <div className="space-y-4">
      {/* 顶部问候行（移动简化：标题 + 图标动作） */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight">工作台</h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">欢迎回来，{userName ?? ''}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="统计图表"
            onClick={() => router.push('/views/charts')}
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground active:bg-muted/60"
          >
            <BarChart3 className="h-5 w-5" />
          </button>
          {canCreate && (
            <button
              type="button"
              aria-label="新建项目"
              onClick={() => router.push('/projects/new')}
              className="btn-gradient flex h-11 w-11 items-center justify-center rounded-full text-primary-foreground"
            >
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* 统计横滑 carousel */}
      <div
        className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {statCards.map((c) => (
          <button
            key={c.title}
            type="button"
            onClick={c.onClick}
            className="min-w-[150px] snap-start rounded-lg border bg-card p-4 text-left active:bg-muted/60"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{c.title}</span>
              <c.icon className={cn('h-4 w-4 shrink-0', c.toneCls)} />
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums">{c.value}</div>
            <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{c.desc}</div>
          </button>
        ))}
      </div>

      {/* 我的催办（醒目强调条） */}
      {(urgeIncoming > 0 || urgeOutgoing > 0) && (
        <MobileCard
          title={
            <span className="flex items-center gap-1.5">
              <BellRing className={cn('h-4 w-4', urgeIncoming > 0 ? 'text-destructive' : 'text-primary')} />
              我的催办
            </span>
          }
          extra={
            <button
              type="button"
              className="-my-3 flex h-11 items-center gap-0.5 text-xs text-primary"
              onClick={() => router.push('/todos?src=' + encodeURIComponent('催办'))}
            >
              全部 <ArrowRight className="h-3 w-3" />
            </button>
          }
        >
          <div className="space-y-2">
            {(urges?.incoming ?? []).length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-destructive">
                  <BellRing className="h-3.5 w-3.5" /> 催办我的（{urges?.incoming.length}）
                </p>
                <div className="space-y-1">
                  {(urges?.incoming ?? []).map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => onUrgeFile(u.projectId, u.requirementId)}
                      className="flex min-h-11 w-full items-center gap-2 rounded px-1 text-left text-xs active:bg-muted/60"
                    >
                      <span className="shrink-0 font-mono text-primary">{u.projectCode}</span>
                      <span className="min-w-0 flex-1 truncate">{u.requirementName}</span>
                      <span className="shrink-0 text-muted-foreground">{u.urgedBy?.name ?? '?'} 催办</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(urges?.outgoing ?? []).length > 0 && (
              <div className="rounded-md border p-2.5">
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <Send className="h-3.5 w-3.5" /> 我催办的（{urges?.outgoing.length}）
                </p>
                <div className="space-y-0.5">
                  {(urges?.outgoing ?? []).map((u) => (
                    <div key={u.id} className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => onUrgeFile(u.projectId, u.requirementId)}
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left active:bg-muted/60"
                      >
                        <span className="shrink-0 font-mono text-primary">{u.projectCode}</span>
                        <span className="min-w-0 flex-1 truncate">{u.requirementName}</span>
                        <span className="shrink-0 text-muted-foreground">催 {u.targetUser?.name ?? '?'}</span>
                      </button>
                      <button
                        type="button"
                        aria-label="撤回催办"
                        onClick={() => onDeleteUrge(u.id, u.requirementName)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(urges?.recentlyDone ?? []).length > 0 && (
              <p className="text-xs text-emerald-600 dark:text-emerald-300">
                ✓ 最近已处理：
                {(urges?.recentlyDone ?? []).slice(0, 3).map((u) => u.requirementName).join('、')}
              </p>
            )}
          </div>
        </MobileCard>
      )}

      {/* 我的待办 */}
      <MobileCard
        title={
          <span className="flex items-center gap-1.5">
            <ListTodo className="h-4 w-4 text-primary" /> 我的待办
          </span>
        }
        extra={todos.length > 0 ? todos.length + ' 项' : undefined}
      >
        {todos.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckCircle className="h-5 w-5 text-emerald-500" /> 暂无未完成待办
          </div>
        ) : (
          <MobileList
            items={todos}
            keyOf={(t) => t.id}
            renderItem={(t) => (
              <MobileListItem
                title={
                  <button
                    type="button"
                    disabled={!t.link}
                    onClick={() => goTodo(t)}
                    className={cn(
                      'min-w-0 truncate text-left',
                      t.link ? 'text-foreground active:text-primary' : 'cursor-default text-foreground/90',
                    )}
                  >
                    {t.title}
                  </button>
                }
                status={
                  <MobileStatusChip label={label(PRIORITY, t.priority)} tone={PRIORITY_TONE[t.priority] ?? 'default'} />
                }
                right={
                  <div className="flex items-center gap-0.5">
                    {t.dueAt && (
                      <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(t.dueAt)}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label="删除该待办"
                      onClick={() => onDeleteTodo(t.id, t.title)}
                      className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                }
              />
            )}
          />
        )}
      </MobileCard>

      {/* 我的交付文件 */}
      <MobileCard
        title={
          <span className="flex items-center gap-1.5">
            <FileUp className="h-4 w-4 text-primary" /> 我的交付文件
          </span>
        }
        extra={
          <button
            type="button"
            className="-my-3 flex h-11 items-center gap-0.5 text-xs text-primary"
            onClick={() => router.push('/files?mine=1')}
          >
            {deliverablesTotal > deliverables.length ? '全部 ' + deliverablesTotal : '文件页'}
            <ArrowRight className="h-3 w-3" />
          </button>
        }
      >
        {deliverables.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckCircle className="h-5 w-5 text-emerald-500" /> 所有交付文件都已处理，继续保持
          </div>
        ) : (
          <MobileList
            items={deliverables.slice(0, 5)}
            keyOf={(r) => r.id}
            renderItem={(r) => {
              const isSubmitted = r.status === 'SUBMITTED' || r.status === 'REVIEWING'
              const isRejected = r.status === 'REJECTED'
              const tone: MobileChipTone = isSubmitted ? 'success' : isRejected ? 'warning' : 'default'
              const chipText = isSubmitted
                ? r.status === 'REVIEWING' ? '审核中' : '已提交待审'
                : isRejected ? '需修订' : '待提交'
              return (
                <MobileListItem
                  title={
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{r.name}</span>
                      {r.overdue && !isSubmitted && <MobileStatusChip label="已逾期" tone="danger" />}
                    </span>
                  }
                  subtitle={<span className="font-mono text-primary">{r.project?.code ?? ''}</span>}
                  status={<MobileStatusChip label={chipText} tone={tone} />}
                  right={
                    <button
                      type="button"
                      onClick={() =>
                        router.push('/files?projectId=' + (r.project?.id ?? '') + '&requirementId=' + r.id)
                      }
                      className="btn-gradient h-9 shrink-0 rounded-md px-3 text-xs text-primary-foreground"
                    >
                      {isRejected ? '去修订' : isSubmitted ? '查看' : '去提交'}
                    </button>
                  }
                />
              )
            }}
          />
        )}
      </MobileCard>

      {/* 最近项目 */}
      <MobileCard
        title="最近项目"
        extra={
          <button
            type="button"
            className="-my-3 flex h-11 items-center gap-0.5 text-xs text-primary"
            onClick={() => router.push('/projects')}
          >
            全部 <ArrowRight className="h-3 w-3" />
          </button>
        }
      >
        <MobileList
          items={projects.slice(0, 4)}
          keyOf={(p) => p.id}
          loading={projectsLoading}
          renderItem={(p) => (
            <MobileListItem
              onClick={() => router.push('/projects/' + p.id)}
              title={
                <span className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-xs font-semibold text-primary">{p.code}</span>
                  <span className="truncate">{p.name}</span>
                </span>
              }
              subtitle={
                <span className="flex items-center gap-2">
                  <MobileStatusChip
                    label={label(PROJECT_STATUS, p.status)}
                    tone={PROJECT_TONE[p.status] ?? 'default'}
                  />
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-3 w-3" />
                    {formatRelativeTime(p.createdAt)}
                  </span>
                </span>
              }
              right={
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div>{p._count?.phases ?? 0} 阶段</div>
                  <div>{p._count?.tasks ?? 0} 任务</div>
                </div>
              }
            />
          )}
        />
      </MobileCard>

      {/* 即将到期的任务 */}
      <MobileCard
        title="即将到期的任务"
        extra={
          <button
            type="button"
            className="-my-3 flex h-11 items-center gap-0.5 text-xs text-primary"
            onClick={() => router.push('/tasks')}
          >
            全部 <ArrowRight className="h-3 w-3" />
          </button>
        }
      >
        {upcomingTasks.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Calendar className="h-5 w-5 text-emerald-500" /> 暂无即将到期的任务
          </div>
        ) : (
          <MobileList
            items={upcomingTasks}
            keyOf={(t) => t.id}
            renderItem={(t) => (
              <MobileListItem
                onClick={() => router.push('/tasks')}
                title={<span className="truncate">{t.title}</span>}
                subtitle={
                  <span>
                    <span className="font-mono">{t.project?.code}</span> · {t.project?.name}
                  </span>
                }
                status={
                  <MobileStatusChip label={label(PRIORITY, t.priority)} tone={PRIORITY_TONE[t.priority] ?? 'default'} />
                }
                right={
                  <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    {t.dueDate ? formatDate(t.dueDate) : '—'}
                  </span>
                }
              />
            )}
          />
        )}
      </MobileCard>

      {/* 最近活动 */}
      <MobileCard title="最近活动">
        {recentActivities.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Activity className="h-5 w-5" /> 暂无最近活动
          </div>
        ) : (
          <MobileList
            items={recentActivities.slice(0, 8)}
            keyOf={(a) => a.id}
            renderItem={(a) => (
              <MobileListItem
                avatar={
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <Activity className="h-4 w-4 text-primary" />
                  </div>
                }
                title={
                  <span>
                    {a.project && <span className="mr-1 font-mono text-xs text-primary">{a.project.code}</span>}
                    <span className="font-medium">{a.title}</span>
                    <span className="ml-1 text-muted-foreground">{a.description}</span>
                  </span>
                }
                subtitle={<span>{formatRelativeTime(a.timestamp)}</span>}
                right={
                  a.project ? (
                    <button
                      type="button"
                      onClick={() => router.push('/projects/' + (a.project?.id ?? ''))}
                      className="h-11 shrink-0 text-xs text-primary active:opacity-70"
                    >
                      查看项目
                    </button>
                  ) : undefined
                }
              />
            )}
          />
        )}
      </MobileCard>
    </div>
  )
}
