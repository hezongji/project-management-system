'use client'

import { PageGuard } from '@/components/layout/page-guard'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AiAutofillButton } from '@/components/ai/ai-autofill-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { TaskService } from '@/services'
import { ApiService } from '@/services/api'
import { Task } from '@/types'
import { formatRelativeTime, formatDate, cn } from '@/lib/utils'
import { label, TASK_STATUS, PRIORITY } from '@/lib/labels'
import { TablePagination } from '@/components/ui/data-table'
import { TaskDrawer } from '@/components/tasks/task-drawer'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { MobileTasks } from '@/components/mobile/tasks'
import { 
  Plus, 
  Search, 
  Filter, 
  MoreHorizontal, 
  Clock, 
  User,
  CheckCircle,
  AlertCircle,
  Circle,
  ChevronDown,
  FileUp,
} from 'lucide-react'

interface ProjectOption { id: string; code: string; name: string }
interface PhaseOption { id: string; code: string; name: string }
interface MemberOption { userId: string; name: string | null }

function TasksPageInner() {
  const router = useRouter()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [priorityFilter, setPriorityFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  // 分页（2026-08-22 UIUX P1 修复）
  const [page, setPage] = useState(1)
  /** 移动端 JS 分支：<1024px 渲染 MobileTasks 子树，桌面 JSX 零改动 */
  const isMobile = useIsMobile()

  // 视图模式：list=平铺列表 / overview=多维总览
  const [viewMode, setViewMode] = useState<'list' | 'overview'>('overview')
  const [overviewDim, setOverviewDim] = useState<'project' | 'dept' | 'status'>('project')
  /** 总览分组展开集合（默认全收起，点击展开） */
  const [overviewOpen, setOverviewOpen] = useState<Set<string>>(new Set())

  // 任务详情抽屉（§8.2③：从列表点开）
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openTask = (id: string) => {
    setDrawerTaskId(id)
    setDrawerOpen(true)
  }

  // ── 新建任务弹窗（P0-5：替代不存在的 /tasks/create 路由）──
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [phaseId, setPhaseId] = useState('')
  const [status, setStatus] = useState('TODO')
  const [priority, setPriority] = useState('MEDIUM')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [phases, setPhases] = useState<PhaseOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])

  async function loadProjects() {
    try {
      const res = await ApiService.get<{ items: ProjectOption[] }>('/projects', {
        page: 1,
        limit: 100,
      })
      setProjects(res.data?.items ?? [])
    } catch {
      setProjects([])
    }
  }

  // 项目变化 → 阶段级联（GET /api/projects/:id/tree）+ 成员（负责人下拉）
  useEffect(() => {
    if (!projectId) {
      setPhases([])
      setMembers([])
      return
    }
    let cancelled = false
    ApiService.get<{ phases: PhaseOption[]; members: MemberOption[] }>(
      `/projects/${projectId}/tree`
    )
      .then((res) => {
        if (cancelled) return
        setPhases(res.data?.phases ?? [])
        setMembers(res.data?.members ?? [])
      })
      .catch(() => {
        if (cancelled) return
        setPhases([])
        setMembers([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const openCreate = () => {
    setTitle('')
    setDescription('')
    setProjectId('')
    setPhaseId('')
    setStatus('TODO')
    setPriority('MEDIUM')
    setAssigneeId('')
    setDueDate('')
    setCreateOpen(true)
    void loadProjects()
  }

  const handleSelectProject = (value: string) => {
    setProjectId(value)
    setPhaseId('')
    setAssigneeId('')
  }

  const handleCreateTask = async () => {
    if (!title.trim()) {
      toast({ variant: 'destructive', description: '请输入任务标题' })
      return
    }
    if (!projectId) {
      toast({ variant: 'destructive', description: '请选择项目' })
      return
    }
    setSubmitting(true)
    try {
      await ApiService.post('/tasks', {
        title: title.trim(),
        description: description.trim() || undefined,
        projectId,
        ...(phaseId && phaseId !== '__none__' ? { phaseId } : {}),
        status,
        priority,
        ...(assigneeId && assigneeId !== '__none__' ? { assigneeId } : {}),
        ...(dueDate ? { dueDate: new Date(dueDate).toISOString() } : {}),
      })
      toast({ description: '任务创建成功 ✓' })
      setCreateOpen(false)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '任务创建失败',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', { searchTerm, statusFilter, priorityFilter, sortBy, sortOrder, page }],
    queryFn: () => TaskService.getTasks({
      page,
      limit: 20,
      search: searchTerm,
      sortBy,
      sortOrder,
      ...(statusFilter !== 'all' && { status: statusFilter }),
      ...(priorityFilter !== 'all' && { priority: priorityFilter }),
    }),
  })

  /** 总览分组：按维度把 tasks 分组（按项目 / 按部门 / 按状态） */
  const overviewGroups = useMemo(() => {
    const tasks = (tasksData?.data?.tasks ?? []) as Task[]
    const groups = new Map<string, Task[]>()
    const keyOf = (t: Task): string => {
      if (overviewDim === 'project') {
        // 项目维度：项目编号 + 项目名称（2026-08-21）
        const p = t.project as { code?: string; name?: string } | undefined
        if (!p?.name) return '未分配项目'
        return p.code ? `${p.code} · ${p.name}` : p.name
      }
      if (overviewDim === 'status') return t.status
      // dept：负责人所在部门
      const a = t.assignee as { department?: { name?: string } | null } | undefined
      return a?.department?.name ?? '未分配部门'
    }
    tasks.forEach((t) => {
      const k = keyOf(t)
      groups.set(k, [...(groups.get(k) ?? []), t])
    })
    return Array.from(groups.entries()).sort((a, b) => {
      const na = a[0].startsWith('未分配') ? -1 : a[1].length
      const nb = b[0].startsWith('未分配') ? -1 : b[1].length
      return nb - na
    })
  }, [tasksData, overviewDim])

  const tasks = tasksData?.data?.tasks || []

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'TODO':
        return <Circle className="h-4 w-4 text-gray-400" />
      case 'IN_PROGRESS':
        return <Clock className="h-4 w-4 text-blue-500" />
      case 'REVIEW':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />
      case 'DONE':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      default:
        return <Circle className="h-4 w-4 text-gray-400" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'TODO':
        return 'secondary'
      case 'IN_PROGRESS':
        return 'default'
      case 'REVIEW':
        return 'outline'
      case 'DONE':
        return 'secondary'
      default:
        return 'secondary'
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'URGENT':
        return 'destructive'
      case 'HIGH':
        return 'destructive'
      case 'MEDIUM':
        return 'default'
      case 'LOW':
        return 'secondary'
      default:
        return 'secondary'
    }
  }

  return (
    <div className="space-y-6">
      {isMobile ? (
        <MobileTasks
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          statusFilter={statusFilter}
          onStatusChange={setStatusFilter}
          priorityFilter={priorityFilter}
          onPriorityChange={setPriorityFilter}
          sortKey={`${sortBy}-${sortOrder}`}
          onSortChange={(v) => {
            const [field, order] = v.split('-')
            setSortBy(field)
            setSortOrder(order as 'asc' | 'desc')
          }}
          page={page}
          onPageChange={setPage}
          tasks={tasks}
          isLoading={isLoading}
          pages={tasksData?.data?.pagination?.pages ?? 1}
          total={tasksData?.data?.pagination?.total ?? 0}
          onOpenTask={openTask}
          onCreate={openCreate}
        />
      ) : (
      <>
        {/* Header（统一标题区） */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">项目任务</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              按项目 / 部门 / 状态多维度总览，可下钻到具体任务
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新建任务
          </Button>
        </div>

        {/* 视图切换：列表 / 总览 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {(
              [
                ['list', '列表'],
                ['overview', '总览'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setViewMode(k)}
                className={cn(
                  'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                  viewMode === k
                    ? 'bg-white text-foreground shadow-sm dark:bg-gray-800'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {viewMode === 'overview' && (
            <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
              {(
                [
                  ['project', '按项目'],
                  ['dept', '按部门'],
                  ['status', '按状态'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOverviewDim(k)}
                  className={cn(
                    'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                    overviewDim === k
                      ? 'bg-white text-foreground shadow-sm dark:bg-gray-800'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索任务..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1) }}
              className="pl-10"
            />
          </div>
          
          <Select
            value={statusFilter}
            onValueChange={(v) => { setStatusFilter(v); setPage(1) }}
          >
            <SelectTrigger className="h-10 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有状态</SelectItem>
              <SelectItem value="TODO">待办</SelectItem>
              <SelectItem value="IN_PROGRESS">进行中</SelectItem>
              <SelectItem value="REVIEW">审核中</SelectItem>
              <SelectItem value="DONE">已完成</SelectItem>
            </SelectContent>
          </Select>
          
          <Select
            value={priorityFilter}
            onValueChange={(v) => { setPriorityFilter(v); setPage(1) }}
          >
            <SelectTrigger className="h-10 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有优先级</SelectItem>
              <SelectItem value="URGENT">紧急</SelectItem>
              <SelectItem value="HIGH">高</SelectItem>
              <SelectItem value="MEDIUM">中</SelectItem>
              <SelectItem value="LOW">低</SelectItem>
            </SelectContent>
          </Select>
          
          <Select
            value={`${sortBy}-${sortOrder}`}
            onValueChange={(v) => {
              const [field, order] = v.split('-')
              setSortBy(field)
              setSortOrder(order as 'asc' | 'desc')
            }}
          >
            <SelectTrigger className="h-10 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt-desc">最新创建</SelectItem>
              <SelectItem value="createdAt-asc">最早创建</SelectItem>
              <SelectItem value="updatedAt-desc">最近更新</SelectItem>
              <SelectItem value="dueDate-asc">截止日期</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Tasks List（列表视图）或总览（多维分组） */}
        {viewMode === 'overview' ? (
          <div className="space-y-4">
            {overviewGroups.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无任务</div>
            )}
            {overviewGroups.map(([groupName, groupTasks]) => {
              const isOpen = overviewOpen.has(groupName)
              return (
                <Card key={groupName}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                    onClick={() =>
                      setOverviewOpen((prev) => {
                        const next = new Set(prev)
                        if (next.has(groupName)) next.delete(groupName)
                        else next.add(groupName)
                        return next
                      })
                    }
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                          !isOpen && '-rotate-90',
                        )}
                      />
                      {/* 项目编号单列（2026-08-21） */}
                      {overviewDim === 'project' && (
                        <span className="w-24 shrink-0 font-mono text-lg font-bold text-primary">
                          {(groupTasks[0].project as { code?: string } | undefined)?.code ?? ''}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-base font-semibold">
                        {overviewDim === 'project'
                          ? ((groupTasks[0].project as { name?: string } | undefined)?.name ??
                              groupName)
                          : groupName}
                      </span>
                    </span>
                    {/* 项目总进度条（2026-08-21 单列固定宽度，垂直对齐便于对比） */}
                    <span className="w-44 shrink-0">
                      {overviewDim === 'project' &&
                      (groupTasks[0] as { projectProgress?: number } | undefined)
                        ?.projectProgress != null ? (
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <span
                              className={cn(
                                'block h-full rounded-full transition-all',
                                ((groupTasks[0] as { projectProgress?: number })
                                  .projectProgress ?? 0) >= 100
                                  ? 'bg-emerald-500'
                                  : 'bg-primary',
                              )}
                              style={{
                                width: `${Math.min(
                                  100,
                                  (groupTasks[0] as { projectProgress?: number })
                                    .projectProgress ?? 0,
                                )}%`,
                              }}
                            />
                          </span>
                          <span className="w-10 shrink-0 text-right text-[11px] font-medium text-muted-foreground">
                            {(groupTasks[0] as { projectProgress?: number }).projectProgress ??
                              0}
                            %
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{groupTasks.length} 个任务</Badge>
                    </span>
                  </button>
                  {isOpen && (
                    <CardContent className="grid gap-2 border-t pt-3">
                      {groupTasks.map((t) => (
                        <div
                          key={t.id}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                          onClick={() => openTask(t.id)}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{t.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {(t.project as { name?: string } | undefined)?.name ?? ''}
                              {' · '}
                              {(t.assignee as { name?: string } | undefined)?.name ?? '未指派'}
                            </div>
                            {(t as { phaseFileStats?: { submitted: number; total: number } | null })
                              .phaseFileStats?.total ? (
                              <div className="mt-1 flex items-center gap-1">
                                <FileUp className="h-3 w-3 text-muted-foreground" />
                                <span
                                  className={
                                    (t as { phaseFileStats: { submitted: number; total: number } })
                                      .phaseFileStats.submitted ===
                                    (t as { phaseFileStats: { submitted: number; total: number } })
                                      .phaseFileStats.total
                                      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                                      : 'text-muted-foreground'
                                  }
                                >
                                  文件{' '}
                                  {(t as { phaseFileStats: { submitted: number; total: number } })
                                    .phaseFileStats.submitted}
                                  /
                                  {(t as { phaseFileStats: { submitted: number; total: number } })
                                    .phaseFileStats.total}{' '}
                                  已提交
                                </span>
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={getStatusColor(t.status)}>
                              {label(TASK_STATUS, t.status)}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        ) : isLoading ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {[...Array(8)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-4">
                  <div className="h-4 bg-muted rounded w-3/4 mb-2"></div>
                  <div className="h-3 bg-muted rounded w-1/2"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {tasks.map((task: Task) => (
              <Card
                key={task.id}
                className="hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => openTask(task.id)}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start space-x-3 flex-1">
                      <div className="flex-shrink-0 mt-1">
                        {getStatusIcon(task.status)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-sm mb-1">{task.title}</h3>
                        <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                          {task.description}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center">
                            <span className="font-medium">项目:</span>
                            <span className="ml-1">{task.project?.name}</span>
                          </div>
                          {task.assignee && (
                            <div className="flex items-center">
                              <User className="h-3 w-3 mr-1" />
                              <span>{task.assignee.name}</span>
                            </div>
                          )}
                          {task.dueDate && (
                            <div className="flex items-center">
                              <Clock className="h-3 w-3 mr-1" />
                              <span>{formatDate(task.dueDate)}</span>
                            </div>
                          )}
                          {task.phaseFileStats && task.phaseFileStats.total > 0 && (
                            <div className="flex items-center gap-1">
                              <FileUp className="h-3 w-3 mr-0.5" />
                              <span
                                className={
                                  task.phaseFileStats.submitted === task.phaseFileStats.total
                                    ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                                    : ''
                                }
                              >
                                文件 {task.phaseFileStats.submitted}/{task.phaseFileStats.total} 已提交
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:ml-4">
                      <Badge variant="secondary" className="font-mono text-[11px]" title="修订版本">
                        v{(task as Task & { revision?: number }).revision ?? 1}
                      </Badge>
                      <Badge variant={getStatusColor(task.status)}>
                        {label(TASK_STATUS, task.status)}
                      </Badge>
                      <Badge variant={getPriorityColor(task.priority)}>
                        {label(PRIORITY, task.priority)}
                      </Badge>
                      <Button variant="ghost" size="sm" asChild>
                        <span onClick={(e) => { e.stopPropagation(); openTask(task.id) }}>
                          <MoreHorizontal className="h-4 w-4" />
                        </span>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* 分页（2026-08-22 UIUX P1 修复） */}
        {tasks.length > 0 && tasksData?.data?.pagination && (
          <TablePagination
            page={page}
            pages={tasksData.data.pagination.pages ?? 1}
            total={tasksData.data.pagination.total ?? 0}
            onPageChange={(p) => {
              setPage(p)
              window.scrollTo({ top: 0 })
            }}
          />
        )}
        
        {tasks.length === 0 && !isLoading && (
          <div className="text-center py-12">
            <CheckCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2">暂无任务</h3>
            <p className="text-muted-foreground mb-4">
              {searchTerm ? '没有找到匹配的任务' : '开始创建您的第一个任务'}
            </p>
            {!searchTerm && (
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                创建任务
              </Button>
            )}
          </div>
        )}
      </>
      )}

      {/* 任务详情抽屉：基本信息/修订历史/标注/评论（§8.2③） */}
      <TaskDrawer
        taskId={drawerTaskId}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      {/* 新建任务弹窗（P0-5） */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
            <DialogDescription>任务将归属所选项目，并挂载到指定阶段</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <AiAutofillButton
              context="新建项目任务，字段：title(任务标题),description(任务描述)"
              fields={['title', 'description']}
              labels={{ title: '任务标题', description: '任务描述' }}
              onApply={(s) => {
                if (s.title?.trim()) setTitle(s.title.trim())
                if (s.description?.trim()) setDescription(s.description.trim())
              }}
            />
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>标题 <span className="text-red-500">*</span></Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="任务标题"
              />
            </div>
            <div className="space-y-1.5">
              <Label>描述</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="任务描述（可选）"
                rows={2}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>项目 <span className="text-red-500">*</span></Label>
                <Select value={projectId} onValueChange={handleSelectProject}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.code ? `${p.code} · ` : ''}{p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>阶段</Label>
                <Select value={phaseId} onValueChange={setPhaseId} disabled={!projectId}>
                  <SelectTrigger>
                    <SelectValue placeholder={projectId ? '选择阶段（可选）' : '先选项目'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不挂阶段</SelectItem>
                    {phases.map((ph) => (
                      <SelectItem key={ph.id} value={ph.id}>
                        {ph.code ? `${ph.code} · ` : ''}{ph.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>状态</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TODO">待办</SelectItem>
                    <SelectItem value="IN_PROGRESS">进行中</SelectItem>
                    <SelectItem value="REVIEW">审核中</SelectItem>
                    <SelectItem value="DONE">已完成</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>优先级</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">低</SelectItem>
                    <SelectItem value="MEDIUM">中</SelectItem>
                    <SelectItem value="HIGH">高</SelectItem>
                    <SelectItem value="URGENT">紧急</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>截止日期</Label>
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>负责人</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId} disabled={!projectId}>
                <SelectTrigger>
                  <SelectValue placeholder={projectId ? '选择负责人（可选）' : '先选项目'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不指定</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.name ?? m.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleCreateTask} disabled={submitting}>
              {submitting ? '创建中…' : '创建任务'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function TasksPage() {
  return (
    <PageGuard pageKey="tasks">
      <TasksPageInner />
    </PageGuard>
  )
}
