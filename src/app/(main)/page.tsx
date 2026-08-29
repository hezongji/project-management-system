'use client'

import { PageGuard } from '@/components/layout/page-guard'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/store/auth'
import { DashboardService, ProjectService } from '@/services'
import { FilesService } from '@/services/files'
import { ApiService } from '@/services/api'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { Project } from '@/types'
import { formatRelativeTime, formatDate, cn } from '@/lib/utils'
import { label, PROJECT_STATUS, PRIORITY, FILE_STATUS } from '@/lib/labels'
import {
  Plus,
  Users,
  Calendar,
  Target,
  BarChart3,
  FileUp,
  Activity,
  FolderKanban,
  CheckCircle2,
  CheckCircle,
  RefreshCw,
  AlertTriangle,
  BellRing,
  Send,
  ArrowRight,
  Clock,
  ListTodo,
  Trash2,
} from 'lucide-react'

/** /dashboard/stats 响应结构（与 route.ts 返回契约对齐） */
interface DashboardStats {
  totalProjects: number
  activeProjects: number
  completedProjects: number
  totalTasks: number
  completedTasks: number
  overdueTasks: number
  totalTeamMembers: number
  upcomingTasks: { id: string; title: string; dueDate: string; priority: string; project: { id: string; code: string; name: string } }[]
  recentActivities: { id: string; type: string; title: string; description: string; timestamp: string; project?: { id: string; code: string; name: string } }[]
}

function DashboardPageInner() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const confirm = useConfirm()
  const { user, isAuthenticated, isLoading: authLoading } = useAuthStore()

  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => DashboardService.getDashboardStats(),
    enabled: isAuthenticated,
  })

  const { data: projects, isLoading: projectsLoading } = useQuery({
    queryKey: ['dashboard-projects'],
    queryFn: () => ProjectService.getProjects({ page: 1, limit: 5 }),
    enabled: isAuthenticated,
  })

  // 我的待提交文件（2026-08-21 个人交付物）
  const { data: myDeliverables } = useQuery({
    queryKey: ['my-deliverables'],
    queryFn: () => FilesService.getMyDeliverables({ limit: 16 }),
    enabled: isAuthenticated,
  })
  const myStats = myDeliverables?.stats ?? {
    waiting: 0,
    submitted: 0,
    rejected: 0,
    overdue: 0,
  }

  // 我的催办（2026-08-22）：别人催办我的 + 我催办别人的
  const { data: myUrges } = useQuery({
    queryKey: ['my-urges'],
    queryFn: () =>
      ApiService.get<{
        incoming: Array<{ id: string; projectCode: string; requirementName: string; urgedBy: { name: string }; createdAt: string }>
        incomingCount: number
        incomingDoneCount: number
        outgoing: Array<{ id: string; projectCode: string; requirementName: string; targetUser: { name: string }; createdAt: string }>
        outgoingCount: number
        outgoingDoneCount: number
        recentlyDone: Array<{ id: string; projectCode: string; requirementName: string; urgedBy: { name: string }; doneAt: string }>
      }>('/urges/mine'),
    enabled: isAuthenticated,
  })
  const urgeIncoming = myUrges?.data?.incomingCount ?? 0
  const urgeOutgoing = myUrges?.data?.outgoingCount ?? 0

  // 我的待办（删除工程第5棒）：未完成待办列表 + 删除入口
  const { data: myTodos } = useQuery({
    queryKey: ['my-todos'],
    queryFn: () =>
      ApiService.get<
        Array<{ id: string; title: string; sourceType: string; link?: string | null; dueAt?: string | null; priority: string }>
      >('/todos?done=0&limit=20'),
    enabled: isAuthenticated,
  })
  const todos = myTodos?.data ?? []

  // ── 删除入口（删除工程第5棒）：DELETE /todos/:id 与 /urges/:id ──
  const handleDeleteTodo = (id: string, title: string) => {
    confirm.ask('删除该待办？', `「${title}」将被永久删除，不可恢复`, async () => {
      try {
        await ApiService.delete(`/todos/${id}`)
        toast({ description: '待办已删除' })
        queryClient.invalidateQueries({ queryKey: ['my-todos'] })
      } catch {
        toast({ variant: 'destructive', description: '删除失败，请重试' })
      }
    }, { confirmText: '删除', destructive: true })
  }

  const handleDeleteUrge = (id: string, name: string) => {
    confirm.ask('撤回该催办？', `对「${name}」的催办记录将被删除，对方待办列表同步移除`, async () => {
      try {
        await ApiService.delete(`/urges/${id}`)
        toast({ description: '催办已撤回' })
        queryClient.invalidateQueries({ queryKey: ['my-urges'] })
      } catch {
        toast({ variant: 'destructive', description: '删除失败，请重试' })
      }
    }, { confirmText: '撤回催办', destructive: true })
  }

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [authLoading, isAuthenticated, router])

  if (authLoading || !isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  const s = stats?.data as DashboardStats | undefined
  const upcomingTasks = s?.upcomingTasks ?? []
  const recentActivities = s?.recentActivities ?? []
  const taskDoneRate =
    s && s.totalTasks > 0 ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0


  const priorityTone = (p: string) =>
    p === 'URGENT' || p === 'HIGH' ? 'destructive' : p === 'MEDIUM' ? 'default' : 'secondary'

  return (
    <div className="space-y-6">
      {/* Header（统一标题区：标题 + 副标题 + 操作按钮 + 分隔线） */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">工作台</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            欢迎回来，{user?.name}！以下是公司项目整体概览
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push('/views/charts')}>
            <BarChart3 className="mr-2 h-4 w-4" />
            统计图表
          </Button>
          {(user?.role === 'ADMIN' || user?.role === 'PROJECT_MANAGER') && (
            <Button onClick={() => router.push('/projects/new')}>
              <Plus className="mr-2 h-4 w-4" />
              新建项目
            </Button>
          )}
        </div>
      </div>

      {/* Stats Cards（真实数据，无虚假趋势） */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          title="总项目数"
          value={s?.totalProjects ?? 0}
          description={`${s?.activeProjects ?? 0} 进行中 · ${s?.completedProjects ?? 0} 已完成`}
          icon={FolderKanban}
          tone="text-blue-500"
          onClick={() => router.push('/projects')}
        />
        <StatCard
          title="总任务数"
          value={s?.totalTasks ?? 0}
          description={`${s?.completedTasks ?? 0} 已完成（完成率 ${taskDoneRate}%）`}
          icon={Target}
          tone="text-emerald-500"
          onClick={() => router.push('/tasks')}
        />
        <StatCard
          title="逾期任务"
          value={s?.overdueTasks ?? 0}
          description="未完成且已过截止日期"
          icon={AlertTriangle}
          tone={(s?.overdueTasks ?? 0) > 0 ? 'text-red-500' : 'text-emerald-500'}
          onClick={() => router.push('/tasks')}
        />
        <StatCard
          title="我的待提交"
          value={myStats.waiting + myStats.rejected}
          description={`${myStats.overdue} 逾期 · ${myStats.submitted} 已提交`}
          icon={FileUp}
          tone={(myStats.overdue ?? 0) > 0 ? 'text-red-500' : 'text-emerald-500'}
          onClick={() => router.push('/files?mine=1')}
        />
        {/* 我的催办（2026-08-22）：别人催办我的 + 我催办别人的，醒目标识 */}
        <StatCard
          title="我的催办"
          value={urgeIncoming > 0 ? urgeIncoming : urgeOutgoing}
          description={
            urgeIncoming > 0
              ? `${urgeIncoming} 条催办我的 · ${urgeOutgoing} 条我催办的`
              : `我催办 ${urgeOutgoing} 条`
          }
          icon={BellRing}
          tone={
            urgeIncoming > 0
              ? 'text-red-500'
              : urgeOutgoing > 0
                ? 'text-amber-500'
                : 'text-muted-foreground'
          }
          onClick={() =>
            router.push(`/todos?src=${encodeURIComponent('催办')}`)
          }
        />
      </div>

      {/* 我的催办详情（2026-08-22）：别人催办我的 + 我催办别人的，醒目展示 */}
      {(urgeIncoming > 0 || urgeOutgoing > 0) && (
        <Card className={urgeIncoming > 0 ? 'border-red-300 dark:border-red-900/60' : ''}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BellRing className={urgeIncoming > 0 ? 'h-4 w-4 text-red-500' : 'h-4 w-4 text-primary'} />
                我的催办
              </CardTitle>
              <CardDescription>
                {urgeIncoming > 0
                  ? `有 ${urgeIncoming} 个交付文件被催办，请尽快处理`
                  : `我催办了 ${urgeOutgoing} 个交付文件`}
              </CardDescription>
            </div>
            {urgeIncoming > 0 && (
              <Badge variant="destructive" className="animate-pulse">
                {urgeIncoming} 条待处理
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {/* 别人催办我的 */}
              {(myUrges?.data?.incoming ?? []).length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50/50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
                    <BellRing className="h-3.5 w-3.5" /> 催办我的（{myUrges?.data?.incoming.length}）
                  </p>
                  <ul className="space-y-1.5">
                    {(myUrges?.data?.incoming ?? []).map((u) => (
                      <li key={u.id} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-primary">{u.projectCode}</span>
                        <span className="truncate text-foreground">{u.requirementName}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {u.urgedBy?.name ?? '?'} 催办
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* 我催办别人的 */}
              {(myUrges?.data?.outgoing ?? []).length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Send className="h-3.5 w-3.5" /> 我催办的（{myUrges?.data?.outgoing.length}）
                  </p>
                  <ul className="space-y-1.5">
                    {(myUrges?.data?.outgoing ?? []).map((u) => (
                      <li key={u.id} className="group/urge flex items-center gap-2 text-xs">
                        <span className="font-mono text-primary">{u.projectCode}</span>
                        <span className="truncate text-foreground">{u.requirementName}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          催 {u.targetUser?.name ?? '?'}
                        </span>
                        {/* 撤回催办（删除工程第5棒）：仅发起人，hover 显示 */}
                        <button
                          type="button"
                          title="撤回该催办"
                          onClick={() => handleDeleteUrge(u.id, u.requirementName)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover/urge:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {/* 最近已处理闭环 */}
            {(myUrges?.data?.recentlyDone ?? []).length > 0 && (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                ✓ 最近已处理：
                {(myUrges?.data?.recentlyDone ?? [])
                  .slice(0, 3)
                  .map((u) => `${u.requirementName}`)
                  .join('、')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 我的待办（删除工程第5棒）：未完成待办 + 删除入口，与通知铃角标同源 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTodo className="h-4 w-4 text-primary" /> 我的待办
            </CardTitle>
            <CardDescription>未完成待办（任务指派 / 采购流转 / 手动创建）</CardDescription>
          </div>
          {todos.length > 0 && (
            <Badge variant="secondary" className="font-normal">{todos.length} 项未完成</Badge>
          )}
        </CardHeader>
        <CardContent>
          {todos.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
              暂无未完成待办
            </div>
          ) : (
            <ul className="divide-y">
              {todos.map((t) => (
                <li key={t.id} className="group/todo flex items-center gap-3 py-2.5">
                  <Badge variant={priorityTone(t.priority)} className="shrink-0 px-1.5 py-0 text-[10px]">
                    {label(PRIORITY, t.priority)}
                  </Badge>
                  <button
                    type="button"
                    disabled={!t.link}
                    onClick={() =>
                      t.link &&
                      router.push(
                        t.link.includes('src=')
                          ? t.link
                          : `${t.link}${t.link.includes('?') ? '&' : '?'}src=${encodeURIComponent('待办')}`,
                      )
                    }
                    className={cn(
                      'min-w-0 flex-1 truncate text-left text-sm',
                      t.link && 'text-foreground hover:text-primary hover:underline',
                      !t.link && 'cursor-default text-foreground/90',
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
                  {/* 删除待办（删除工程第5棒）：hover 显示 */}
                  <button
                    type="button"
                    title="删除该待办"
                    onClick={() => handleDeleteTodo(t.id, t.title)}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover/todo:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 我的待提交文件（2026-08-21 个人交付物 · 多状态视图） */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileUp className="h-4 w-4 text-primary" /> 我的交付文件
            </CardTitle>
            <CardDescription>
              待提交 / 已提交 / 需修订的交付文件一览
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {myDeliverables && myDeliverables.pagination.total > 0 && (
              <Badge variant="outline" className="font-normal">
                共 {myDeliverables.pagination.total} 项
              </Badge>
            )}
            {myStats.submitted > 0 && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {myStats.submitted} 已提交
              </Badge>
            )}
            {myStats.overdue > 0 && (
              <Badge variant="destructive">{myStats.overdue} 逾期</Badge>
            )}
            {myStats.rejected > 0 && (
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {myStats.rejected} 需修订
              </Badge>
            )}
            {myStats.waiting > 0 && (
              <Badge variant="secondary">{myStats.waiting} 待提交</Badge>
            )}
            <Button variant="ghost" size="sm" onClick={() => router.push('/files?mine=1')}>
              {myDeliverables &&
              myDeliverables.pagination.total > myDeliverables.items.length
                ? `查看全部 ${myDeliverables.pagination.total} 项`
                : '文件页'}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!myDeliverables || myDeliverables.items.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <CheckCircle className="h-5 w-5 text-emerald-500" />
              所有交付文件都已处理，继续保持
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">文件名称</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">项目编号</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">项目</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">截止日期</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {myDeliverables.items.map((r) => {
                    // 状态徽章（2026-08-21 多状态）
                    const isSubmitted = r.status === 'SUBMITTED' || r.status === 'REVIEWING'
                    const isRejected = r.status === 'REJECTED'
                    const isOverdue = r.overdue && !isSubmitted
                    const statusBadge = isSubmitted ? (
                      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        {r.status === 'REVIEWING' ? '审核中' : '已提交待审'}
                      </Badge>
                    ) : isRejected ? (
                      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                        <RefreshCw className="mr-1 h-3 w-3" /> 需修订
                      </Badge>
                    ) : (
                      <Badge variant="outline">待提交</Badge>
                    )
                    return (
                      <tr
                        key={r.id}
                        className="border-t transition-colors hover:bg-muted/30"
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{r.name}</span>
                            {isOverdue && (
                              <Badge variant="destructive" className="shrink-0 px-1.5 py-0 text-[10px]">
                                已逾期
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-foreground/80 md:hidden">
                            <span className="font-mono text-primary">{r.project?.code ?? ''}</span>{' '}
                            {r.project?.name ?? ''}
                          </div>
                        </td>
                        <td className="hidden px-3 py-2 md:table-cell">
                          <span className="font-mono text-xs text-primary">
                            {r.project?.code ?? '—'}
                          </span>
                        </td>
                        <td className="hidden px-3 py-2 md:table-cell">
                          <div className="truncate text-sm font-medium text-foreground">
                            {r.project?.name ?? '—'}
                          </div>
                        </td>
                        <td className="hidden px-3 py-2 text-xs text-foreground/75 sm:table-cell">
                          {r.dueDate ? formatDate(r.dueDate) : '—'}
                        </td>
                        <td className="px-3 py-2">{statusBadge}</td>
                        <td className="px-3 py-2 text-right">
                          {!isSubmitted ? (
                            <Button
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onClick={() =>
                                router.push(
                                  `/files?projectId=${r.project?.id}&requirementId=${r.id}`,
                                )
                              }
                            >
                              <FileUp className="mr-1 h-3.5 w-3.5" />
                              {isRejected ? '去修订' : '去提交'}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() =>
                                router.push(
                                  `/files?projectId=${r.project?.id}&requirementId=${r.id}`,
                                )
                              }
                            >
                              查看
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 中栏：最近项目 + 即将到期任务 */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">最近项目</CardTitle>
              <CardDescription>最新创建的项目</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => router.push('/projects')}>
              全部
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent>
            {projectsLoading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : (projects?.data?.projects?.length ?? 0) === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <FolderKanban className="mx-auto mb-3 h-10 w-10 opacity-40" />
                暂无项目，点击右上角「新建项目」开始
              </div>
            ) : (
              <div className="divide-y">
                {projects?.data?.projects?.slice(0, 4).map((project: Project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => router.push(`/projects/${project.id}`)}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-primary">
                          {project.code}
                        </span>
                        <span className="truncate text-sm font-medium">{project.name}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <Badge
                          variant={
                            project.status === 'ACTIVE'
                              ? 'default'
                              : project.status === 'COMPLETED'
                                ? 'secondary'
                                : 'outline'
                          }
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {label(PROJECT_STATUS, project.status)}
                        </Badge>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(project.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-muted-foreground">
                        {project._count?.phases ?? 0} 阶段
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {project._count?.tasks ?? 0} 任务
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 即将到期任务 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">即将到期的任务</CardTitle>
              <CardDescription>未来 7 天内截止（我负责/我创建）</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => router.push('/tasks')}>
              全部
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent>
            {upcomingTasks.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Calendar className="mx-auto mb-3 h-10 w-10 opacity-40" />
                暂无即将到期的任务
              </div>
            ) : (
              <div className="divide-y">
                {upcomingTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => router.push('/tasks')}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{task.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{task.project?.code}</span> · {task.project?.name}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={priorityTone(task.priority)} className="px-1.5 py-0 text-[10px]">
                        {label(PRIORITY, task.priority)}
                      </Badge>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {task.dueDate ? formatDate(task.dueDate) : '—'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 最近活动 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">最近活动</CardTitle>
          <CardDescription>公司内最新的操作动态</CardDescription>
        </CardHeader>
        <CardContent>
          {recentActivities.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Activity className="mx-auto mb-3 h-10 w-10 opacity-40" />
              暂无最近活动
            </div>
          ) : (
            <div className="divide-y">
              {recentActivities.slice(0, 8).map((activity) => (
                <div key={activity.id} className="flex items-start gap-3 py-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Activity className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {activity.project && (
                        <span className="font-mono text-xs text-primary">
                          {activity.project.code}
                        </span>
                      )}
                      <span className="ml-1 font-medium">{activity.title}</span>
                      <span className="ml-1 text-muted-foreground">{activity.description}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatRelativeTime(activity.timestamp)}
                    </p>
                  </div>
                  {activity.project && (
                    <button
                      type="button"
                      onClick={() => router.push(`/projects/${activity.project?.id}`)}
                      className="shrink-0 text-xs text-primary hover:underline"
                    >
                      查看项目
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 删除确认弹窗（删除工程第5棒：待办/催办） */}
      {confirm.render}
    </div>
  )
}


export default function DashboardPage() {
  return (
    <PageGuard pageKey="dashboard">
      <DashboardPageInner />
    </PageGuard>
  )
}

const StatCard = ({ title, value, description, icon: Icon, onClick, tone }: {
  title: string
  value: string | number
  description?: string
  icon: any
  onClick?: () => void
  tone?: string
}) => (
  <Card
    className={onClick ? 'cursor-pointer transition-shadow hover:shadow-md' : undefined}
    onClick={onClick}
  >
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      <Icon className={`h-4 w-4 ${tone ?? 'text-muted-foreground'}`} />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{value}</div>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </CardContent>
  </Card>
)
