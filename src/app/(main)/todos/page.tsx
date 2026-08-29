'use client'

/**
 * 待办中心 /todos —— QA批次B4 P0 修复（2026-08-23）
 *
 * 背景：工作台「我的催办」卡片跳 /todos?src=催办，但该页面此前不存在（404）。
 *
 * 两个 Tab：
 *  - 我的待办：GET /todos?done=0|1（未完成/已完成切换），行 = 优先级Badge + 标题
 *    （点击跳 t.link，无 link 置灰；src=待办 拼接逻辑与工作台一致）+ 截止时间
 *    + 完成按钮（PATCH /todos/:id { done }，已完成列表可撤销完成）
 *  - 催办中心：GET /urges/mine，三分区 —— 催办我的（红点强调）/ 我催办的（保留撤回）
 *    / 最近已处理；行点击跳 /files?projectId=X&requirementId=Y&src=催办 进入具体事务
 *
 * URL ?src=催办 → 默认选中催办中心 Tab；其他值或无参 → 我的待办。
 * 页面权限：不加 pageKey（与 /help 同策略，全员可见——待办是个人数据，
 * API 层已按 userId 隔离）。
 */

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiService } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatDate, formatRelativeTime } from '@/lib/utils'
import { label, PRIORITY } from '@/lib/labels'
import {
  ListTodo,
  BellRing,
  Send,
  CheckCircle,
  CheckCircle2,
  Clock,
  Trash2,
  Undo2,
} from 'lucide-react'

/** TodoItem（GET /todos 返回契约，与 /api/todos/route.ts 对齐） */
interface TodoItem {
  id: string
  title: string
  sourceType: string
  link?: string | null
  dueAt?: string | null
  priority: string
}

/** UrgeRecord 行（GET /urges/mine 返回契约，含跳转所需 projectId/requirementId） */
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

interface MyUrges {
  incoming: UrgeItem[]
  outgoing: UrgeItem[]
  recentlyDone: UrgeItem[]
  incomingCount: number
  outgoingCount: number
}

/** 待办标题跳转目标：追加 src=待办 来源标记（已有 src= 则不覆盖，与工作台一致） */
function todoLinkTarget(link: string): string {
  const target = link.includes('src=')
    ? link
    : `${link}${link.includes('?') ? '&' : '?'}src=${encodeURIComponent('待办')}`
  // 同源兜底：非站内路径一律回落首页（参照 lib/notify.ts 写法）
  return target.startsWith('/') ? target : '/'
}

function TodosPageInner() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const confirm = useConfirm()
  const { isAuthenticated } = useAuthStore()
  const searchParams = useSearchParams()

  /** Tab 初始值：?src=催办 → 催办中心；其他/无参 → 我的待办 */
  const [tab, setTab] = useState<'todo' | 'urge'>(
    searchParams.get('src') === '催办' ? 'urge' : 'todo',
  )
  /** 同路由 search 变化不重挂载：用户已停在 /todos 时再次跳 /todos?src=催办
   *  （通知铃/工作台入口），useEffect 兜底同步 Tab（首次挂载走 useState 初始化器） */
  useEffect(() => {
    if (searchParams.get('src') === '催办') setTab('urge')
  }, [searchParams])
  /** 待办列表状态：0=未完成 / 1=已完成 */
  const [doneFilter, setDoneFilter] = useState<0 | 1>(0)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // 我的待办（done=0/1 切换）
  const { data: todosData, isLoading: todosLoading } = useQuery({
    queryKey: ['todos-page', doneFilter],
    queryFn: () => ApiService.get<TodoItem[]>(`/todos?done=${doneFilter}&limit=200`),
    enabled: isAuthenticated,
  })
  const todos = todosData?.data ?? []

  // 我的催办（三分区数据）
  const { data: urgesData, isLoading: urgesLoading } = useQuery({
    queryKey: ['todos-urges'],
    queryFn: () => ApiService.get<MyUrges>('/urges/mine'),
    enabled: isAuthenticated,
  })
  const urges = urgesData?.data
  const incoming = urges?.incoming ?? []
  const outgoing = urges?.outgoing ?? []
  const recentlyDone = urges?.recentlyDone ?? []

  /** 完成 / 撤销完成（PATCH /todos/:id { done }） */
  const handleToggleTodo = async (t: TodoItem) => {
    const nextDone = doneFilter === 0 // 未完成列表 → 标记完成；已完成列表 → 撤销完成
    setTogglingId(t.id)
    try {
      await ApiService.patch(`/todos/${t.id}`, { done: nextDone })
      toast({ description: nextDone ? '待办已完成 ✓' : '已撤销完成' })
      queryClient.invalidateQueries({ queryKey: ['todos-page'] })
      queryClient.invalidateQueries({ queryKey: ['my-todos'] })
    } catch {
      toast({ variant: 'destructive', description: '操作失败，请重试' })
    } finally {
      setTogglingId(null)
    }
  }

  /** 撤回催办（DELETE /urges/:id，仅发起人，与工作台 handleDeleteUrge 一致） */
  const handleDeleteUrge = (id: string, name: string) => {
    confirm.ask('撤回该催办？', `对「${name}」的催办记录将被删除，对方待办列表同步移除`, async () => {
      try {
        await ApiService.delete(`/urges/${id}`)
        toast({ description: '催办已撤回' })
        queryClient.invalidateQueries({ queryKey: ['todos-urges'] })
        queryClient.invalidateQueries({ queryKey: ['my-urges'] })
      } catch {
        toast({ variant: 'destructive', description: '删除失败，请重试' })
      }
    }, { confirmText: '撤回催办', destructive: true })
  }

  /** 催办行跳转：进入对应项目的交付事务（files 页按 projectId+requirementId 定位高亮）；
   *  projectId/requirementId 任一为空视为数据不完整，提示后不跳转（防御脏数据行） */
  const goUrgeFile = (u: UrgeItem) => {
    if (!u.projectId || !u.requirementId) {
      toast({ variant: 'destructive', description: '催办目标数据不完整' })
      return
    }
    router.push(
      `/files?projectId=${encodeURIComponent(u.projectId)}&requirementId=${encodeURIComponent(u.requirementId)}&src=${encodeURIComponent('催办')}`,
    )
  }

  const priorityTone = (p: string) =>
    p === 'URGENT' || p === 'HIGH' ? 'destructive' : p === 'MEDIUM' ? 'default' : 'secondary'

  return (
    <div className="space-y-6">
      {/* Header（统一标题区：标题 + 副标题 + 分隔线） */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">待办中心</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            我的待办与催办一览（任务指派 / 采购流转 / 交付催办 / 手动创建）
          </p>
        </div>
        {incoming.length > 0 && (
          <Badge variant="destructive" className="animate-pulse">
            {incoming.length} 条催办待处理
          </Badge>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'todo' | 'urge')}>
        <TabsList>
          <TabsTrigger value="todo">
            <ListTodo className="mr-1.5 h-4 w-4" /> 我的待办
          </TabsTrigger>
          <TabsTrigger value="urge">
            <BellRing className="mr-1.5 h-4 w-4" /> 催办中心
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1：我的待办（done=0/1 切换） ── */}
        <TabsContent value="todo" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ListTodo className="h-4 w-4 text-primary" /> 我的待办
                </CardTitle>
                <CardDescription>
                  {doneFilter === 0 ? '未完成待办（按优先级 + 时间排序）' : '已完成待办'}
                </CardDescription>
              </div>
              {/* 未完成 / 已完成 切换 */}
              <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
                {(
                  [
                    [0, '未完成'],
                    [1, '已完成'],
                  ] as const
                ).map(([k, l]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDoneFilter(k)}
                    className={cn(
                      'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                      doneFilter === k
                        ? 'bg-white text-foreground shadow-sm dark:bg-gray-800'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {todosLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
                  ))}
                </div>
              ) : todos.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <CheckCircle className="h-5 w-5 text-emerald-500" />
                  {doneFilter === 0 ? '暂无未完成待办' : '暂无已完成待办'}
                </div>
              ) : (
                <ul className="divide-y">
                  {todos.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-2.5">
                      <Badge variant={priorityTone(t.priority)} className="shrink-0 px-1.5 py-0 text-[10px]">
                        {label(PRIORITY, t.priority)}
                      </Badge>
                      <button
                        type="button"
                        disabled={!t.link}
                        onClick={() => t.link && router.push(todoLinkTarget(t.link))}
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
                      {/* 完成 / 撤销完成（PATCH done） */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs"
                        disabled={togglingId === t.id}
                        onClick={() => handleToggleTodo(t)}
                      >
                        {doneFilter === 0 ? (
                          <>
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-emerald-500" />
                            完成
                          </>
                        ) : (
                          <>
                            <Undo2 className="mr-1 h-3.5 w-3.5" />
                            撤销完成
                          </>
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2：催办中心（三分区） ── */}
        <TabsContent value="urge" className="mt-4 space-y-4">
          {urgesLoading ? (
            <Card>
              <CardContent className="space-y-2 p-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
                ))}
              </CardContent>
            </Card>
          ) : (
            <>
              {/* 分区 1：别人催办我的（红点强调） */}
              <Card className={incoming.length > 0 ? 'border-red-300 dark:border-red-900/60' : ''}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BellRing className={incoming.length > 0 ? 'h-4 w-4 text-red-500' : 'h-4 w-4 text-primary'} />
                    催办我的
                    {incoming.length > 0 && (
                      <Badge variant="destructive" className="animate-pulse">
                        {incoming.length} 条待处理
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {incoming.length > 0 ? '有交付文件被催办，点击行进入具体事务尽快处理' : '暂无被催办的交付文件'}
                  </CardDescription>
                </CardHeader>
                {incoming.length > 0 && (
                  <CardContent className="pt-0">
                    <ul className="divide-y">
                      {incoming.map((u) => (
                        <li key={u.id}>
                          <button
                            type="button"
                            onClick={() => goUrgeFile(u)}
                            className="flex w-full items-center gap-2 py-2.5 text-left transition-colors hover:bg-muted/50"
                            title="进入具体事务"
                          >
                            {/* 红点强调（未处理） */}
                            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                            <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                              {u.projectCode}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {u.requirementName}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {u.urgedBy?.name ?? '?'} 催办 · {formatRelativeTime(u.createdAt)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                )}
              </Card>

              {/* 分区 2：我催办别人的（保留撤回） */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Send className="h-4 w-4 text-amber-500" /> 我催办的
                    {outgoing.length > 0 && (
                      <Badge variant="secondary" className="font-normal">{outgoing.length} 条</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {outgoing.length > 0 ? '点击行进入具体事务查看进度，hover 可撤回催办' : '暂无我发起的催办'}
                  </CardDescription>
                </CardHeader>
                {outgoing.length > 0 && (
                  <CardContent className="pt-0">
                    <ul className="divide-y">
                      {outgoing.map((u) => (
                        <li key={u.id} className="group/urge">
                          <div className="flex items-center gap-2 py-2.5 transition-colors group-hover/urge:bg-muted/50">
                            <button
                              type="button"
                              onClick={() => goUrgeFile(u)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              title="进入具体事务"
                            >
                              <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                                {u.projectCode}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                {u.requirementName}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                催 {u.targetUser?.name ?? '?'} · {formatRelativeTime(u.createdAt)}
                              </span>
                            </button>
                            {/* 撤回催办（hover 显示，不触发行跳转） */}
                            <button
                              type="button"
                              title="撤回该催办"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteUrge(u.id, u.requirementName)
                              }}
                              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover/urge:opacity-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                )}
              </Card>

              {/* 分区 3：最近已处理（闭环） */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> 最近已处理
                  </CardTitle>
                  <CardDescription>
                    {recentlyDone.length > 0 ? '被催办后已提交的交付文件（闭环）' : '暂无最近已处理的催办'}
                  </CardDescription>
                </CardHeader>
                {recentlyDone.length > 0 && (
                  <CardContent className="pt-0">
                    <ul className="divide-y">
                      {recentlyDone.map((u) => (
                        <li key={u.id}>
                          <button
                            type="button"
                            onClick={() => goUrgeFile(u)}
                            className="flex w-full items-center gap-2 py-2.5 text-left transition-colors hover:bg-muted/50"
                            title="进入具体事务"
                          >
                            <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                            <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                              {u.projectCode}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {u.requirementName}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {u.urgedBy?.name ?? '?'} 催办 · 已处理
                              {u.doneAt ? `（${formatRelativeTime(u.doneAt)}）` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                )}
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* 删除/撤回确认弹窗 */}
      {confirm.render}
    </div>
  )
}

export default function TodosPage() {
  /** useSearchParams 须 <Suspense> 包裹（Next.js 预渲染约束，同 /views/charts） */
  return (
    <Suspense fallback={null}>
      <TodosPageInner />
    </Suspense>
  )
}
