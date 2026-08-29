'use client'

/**
 * 任务详情抽屉 —— 《开发文档-项目管理系统重构》§8.2③
 * 全局组件：从看板/任务列表点开（<TaskDrawer taskId open onClose />）。
 *
 * 四区布局：
 *   ① 基本信息：标题/状态/优先级/负责人/截止日/描述（edit 权限时可编辑；
 *      「直接保存」走 PATCH 普通更新；「存为修订」走 POST revisions——
 *      changeSummary>10 字，服务端快照旧值，revision+1）
 *   ② 修订历史：时间线 + 字段 diff 高亮（旧值删除线红/新值绿）+ 回滚按钮
 *   ③ 标注列表：彩色便签 + 解决操作
 *   ④ 评论：@联想（→ 通知+待办）
 *
 * 权限：按钮显隐由 GET /api/tasks/:id 返回的 data.permissions 驱动（§4.7，
 * 前端不自算权限）；服务端 requireCan 终审。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/services/api-instance'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/store/auth'
import { X, Save, GitPullRequestArrow, Pencil, Ban, Trash2 } from 'lucide-react'
import { RevisionTimeline } from './revision-timeline'
import { AnnotationList } from './annotation-list'
import { CommentSection } from './comment-section'
import { globalConfirm } from '@/lib/global-confirm'
import {
  TaskDetail,
  TASK_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  TaskStatus,
  TaskPriority,
} from './types'

export interface TaskDrawerProps {
  taskId: string | null
  open: boolean
  onClose: () => void
}

/** 六字段草稿（编辑态） */
interface Draft {
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string
  dueDate: string
}

function draftOf(task: TaskDetail): Draft {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId ?? '',
    dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
  }
}

/** 草稿 vs 当前任务 → patch（仅含变化字段） */
function draftToPatch(task: TaskDetail, d: Draft) {
  const patch: Record<string, unknown> = {}
  if (d.title !== task.title) patch.title = d.title
  if (d.description !== (task.description ?? '')) patch.description = d.description || null
  if (d.status !== task.status) patch.status = d.status
  if (d.priority !== task.priority) patch.priority = d.priority
  if (d.assigneeId !== (task.assigneeId ?? '')) patch.assigneeId = d.assigneeId || null
  if (d.dueDate !== (task.dueDate ? task.dueDate.slice(0, 10) : '')) {
    patch.dueDate = d.dueDate ? new Date(d.dueDate).toISOString() : null
  }
  return patch
}

export function TaskDrawer({ taskId, open, onClose }: TaskDrawerProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const currentUserId = user?.id ?? ''

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [changeSummary, setChangeSummary] = useState('')
  const [revisionBusy, setRevisionBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  const { data: task, isLoading, refetch } = useQuery<TaskDetail>({
    queryKey: ['task', taskId],
    queryFn: async () => {
      const res = await api.get(`/tasks/${taskId}`)
      return res.data.data as TaskDetail
    },
    enabled: open && !!taskId,
  })

  // 打开/切换任务时重置编辑态
  useEffect(() => {
    setEditing(false)
    setDraft(null)
    setRevisionOpen(false)
    setChangeSummary('')
  }, [taskId, open])

  useEffect(() => {
    if (task && editing && draft === null) setDraft(draftOf(task))
  }, [task, editing, draft])

  const invalidateLists = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] })
    queryClient.invalidateQueries({ queryKey: ['task', taskId] })
  }, [queryClient, taskId])

  const patch = useMemo(
    () => (task && draft ? draftToPatch(task, draft) : {}),
    [task, draft],
  )
  const patchCount = Object.keys(patch).length

  const startEdit = () => {
    setDraft(task ? draftOf(task) : null)
    setEditing(true)
  }

  const savePatch = async () => {
    if (!task || patchCount === 0) return
    setSaving(true)
    try {
      const res = await api.patch(`/tasks/${task.id}`, patch)
      toast({ title: '已保存', description: res.data?.message })
      setEditing(false)
      setDraft(null)
      invalidateLists()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '保存失败', description: msg, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const submitRevision = async () => {
    if (!task || patchCount === 0) {
      toast({ title: '请先修改要修订的字段', variant: 'destructive' })
      return
    }
    const summary = changeSummary.trim()
    if (summary.length <= 10) {
      toast({
        title: '修订说明太短',
        description: `changeSummary 必须超过 10 个字（当前 ${summary.length} 字）：重大变更必须留下可追溯的说明`,
        variant: 'destructive',
      })
      return
    }
    setRevisionBusy(true)
    try {
      const res = await api.post(`/tasks/${task.id}/revisions`, {
        changeSummary: summary,
        patch,
      })
      toast({ title: '修订成功', description: res.data?.message })
      setEditing(false)
      setDraft(null)
      setRevisionOpen(false)
      setChangeSummary('')
      invalidateLists()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '修订失败', description: msg, variant: 'destructive' })
    } finally {
      setRevisionBusy(false)
    }
  }

  const canEdit = task?.permissions?.edit === true && !task.project.isArchived
  // 删除工程第 3 棒：标注/评论删除显隐（ADMIN 或任务 edit 权限；服务端终审作者/PM/ADMIN）
  const canModerate = user?.role === 'ADMIN' || task?.permissions?.edit === true

  // 取消任务（P2-9：PATCH status=CANCELLED，引擎会把 CANCELLED 剔除出阶段分母）
  const cancelTask = async () => {
    if (!taskId || !task) return
    if (!(await globalConfirm(`确认取消任务「${task.title}」？取消后可重新编辑状态恢复。`))) return
    setActionBusy(true)
    try {
      await api.patch(`/tasks/${taskId}`, { status: 'CANCELLED' })
      toast({ description: '任务已取消' })
      invalidateLists()
      void refetch()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '取消失败' })
    } finally {
      setActionBusy(false)
    }
  }

  // 删除任务（P2-9：DELETE /api/tasks/:id，后端先置 CANCELLED 重算阶段再物理删除）
  const deleteTask = async () => {
    if (!taskId || !task) return
    if (!(await globalConfirm(`确认永久删除任务「${task.title}」？修订历史/标注/评论将一并删除，不可恢复。`))) return
    setActionBusy(true)
    try {
      await api.delete(`/tasks/${taskId}`)
      toast({ description: '任务已删除' })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.removeQueries({ queryKey: ['task', taskId] })
      onClose()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '删除失败' })
      setActionBusy(false)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-2xl">
          {/* ── 头部 ── */}
          <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {task?.project && (
                  <span className="font-mono">{task.project.code}</span>
                )}
                {task?.phase && (
                  <Badge variant="outline" className="h-5 text-[11px]">
                    {task.phase.code} {task.phase.name}
                  </Badge>
                )}
                {task && <Badge variant="secondary" className="h-5 text-[11px]">v{task.revision}</Badge>}
                {task?.project.isArchived && <Badge variant="destructive" className="h-5 text-[11px]">项目已归档·只读</Badge>}
              </div>
              {isLoading ? (
                <div className="mt-1 h-7 w-2/3 animate-pulse rounded bg-muted" />
              ) : (
                <DialogPrimitive.Title className="mt-1 truncate text-lg font-semibold leading-7">
                  {task?.title ?? ''}
                </DialogPrimitive.Title>
              )}
            </div>
            <DialogPrimitive.Close className="rounded-sm opacity-70 transition-opacity hover:opacity-100">
              <X className="h-4 w-4" />
              <span className="sr-only">关闭</span>
            </DialogPrimitive.Close>
          </div>

          {/* ── 主体 ── */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {!task ? (
              <div className="py-20 text-center text-sm text-muted-foreground">加载任务中…</div>
            ) : (
              <div className="space-y-5">
                {/* ① 基本信息 */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground">基本信息</h3>
                    {canEdit && !editing && (
                      <div className="flex items-center gap-1">
                        {task.status !== 'CANCELLED' && (
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={cancelTask} disabled={actionBusy}>
                            <Ban className="mr-1 h-3 w-3" />
                            取消任务
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={deleteTask} disabled={actionBusy}>
                          <Trash2 className="mr-1 h-3 w-3" />
                          删除
                        </Button>
                        <Button size="sm" variant="outline" onClick={startEdit}>
                          <Pencil className="mr-1 h-3 w-3" />
                          编辑
                        </Button>
                      </div>
                    )}
                  </div>

                  {!editing ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <Info label="状态" value={TASK_STATUS_LABEL[task.status]} />
                      <Info label="优先级" value={TASK_PRIORITY_LABEL[task.priority]} />
                      <Info label="负责人" value={task.assignee?.name ?? '未指派'} />
                      <Info
                        label="截止日期"
                        value={task.dueDate ? new Date(task.dueDate).toLocaleDateString('zh-CN') : '—'}
                      />
                      <Info label="创建人" value={task.creator?.name ?? '—'} />
                      <Info
                        label="完成时间"
                        value={task.completedAt ? new Date(task.completedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                      />
                      <div className="col-span-2">
                        <p className="text-xs text-muted-foreground">描述</p>
                        <p className="mt-0.5 whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 min-h-10">
                          {task.description || '（无描述）'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    draft && (
                      <div className="space-y-3 rounded-md border p-3">
                        <Field label="标题">
                          <input
                            className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="状态">
                            <select
                              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                              value={draft.status}
                              onChange={(e) => setDraft({ ...draft, status: e.target.value as TaskStatus })}
                            >
                              {Object.entries(TASK_STATUS_LABEL).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="优先级">
                            <select
                              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                              value={draft.priority}
                              onChange={(e) => setDraft({ ...draft, priority: e.target.value as TaskPriority })}
                            >
                              {Object.entries(TASK_PRIORITY_LABEL).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="负责人">
                            <select
                              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                              value={draft.assigneeId}
                              onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}
                            >
                              <option value="">未指派</option>
                              {(task.mentionCandidates ?? []).map((u) => (
                                <option key={u.id} value={u.id}>{u.name}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="截止日期">
                            <input
                              type="date"
                              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm"
                              value={draft.dueDate}
                              onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                            />
                          </Field>
                        </div>
                        <Field label="描述">
                          <textarea
                            rows={3}
                            className="w-full resize-none rounded border bg-background px-2 py-1.5 text-sm"
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                          />
                        </Field>

                        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                          <Button size="sm" variant="outline" onClick={() => { setEditing(false); setDraft(null) }}>
                            取消
                          </Button>
                          <Button size="sm" disabled={patchCount === 0 || saving} onClick={savePatch}>
                            <Save className="mr-1 h-3 w-3" />
                            {saving ? '保存中…' : `直接保存${patchCount > 0 ? `（${patchCount} 处变更）` : ''}`}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={patchCount === 0}
                            onClick={() => setRevisionOpen((v) => !v)}
                          >
                            <GitPullRequestArrow className="mr-1 h-3 w-3" />
                            发起修订…
                          </Button>
                        </div>

                        {revisionOpen && (
                          <div className="space-y-2 rounded-md border border-dashed bg-muted/30 p-3">
                            <p className="text-xs text-muted-foreground">
                              本次将把 {patchCount} 处变更登记为一次修订（服务端快照当前值，版本 v{task.revision} → v{task.revision + 1}）：
                            </p>
                            <ul className="list-inside list-disc text-xs text-muted-foreground">
                              {Object.keys(patch).map((f) => (
                                <li key={f}>{f}</li>
                              ))}
                            </ul>
                            <textarea
                              rows={2}
                              placeholder="修订说明（changeSummary，必须超过 10 个字）"
                              className="w-full resize-none rounded border bg-background px-2 py-1.5 text-sm"
                              value={changeSummary}
                              onChange={(e) => setChangeSummary(e.target.value)}
                            />
                            <p className={`text-xs ${changeSummary.trim().length > 10 ? 'text-green-600' : 'text-muted-foreground'}`}>
                              {changeSummary.trim().length} / 需 &gt;10 字
                            </p>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => setRevisionOpen(false)}>
                                收起
                              </Button>
                              <Button size="sm" disabled={revisionBusy || patchCount === 0} onClick={submitRevision}>
                                {revisionBusy ? '提交中…' : '确认修订'}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  )}
                </section>

                {/* ②③④ 修订 / 标注 / 评论 */}
                <Tabs defaultValue="revisions">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="revisions" className="text-xs">
                      修订历史
                      {(task.revisions?.length ?? 0) > 0 && (
                        <span className="ml-1 rounded bg-muted px-1 text-[10px]">{task.revisions.length}</span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="annotations" className="text-xs">
                      标注
                      {(task.annotations?.length ?? 0) > 0 && (
                        <span className="ml-1 rounded bg-muted px-1 text-[10px]">{task.annotations.length}</span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="comments" className="text-xs">
                      评论
                      {(task.comments?.length ?? 0) > 0 && (
                        <span className="ml-1 rounded bg-muted px-1 text-[10px]">{task.comments.length}</span>
                      )}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="revisions" className="mt-3">
                    <RevisionTimeline task={task} onMutated={invalidateLists} />
                  </TabsContent>
                  <TabsContent value="annotations" className="mt-3">
                    <AnnotationList task={task} currentUserId={currentUserId} canModerate={canModerate} onMutated={invalidateLists} />
                  </TabsContent>
                  <TabsContent value="comments" className="mt-3">
                    <CommentSection task={task} currentUserId={currentUserId} canModerate={canModerate} onMutated={invalidateLists} />
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ───────────────────────────── 小件 ─────────────────────────────

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate">{value}</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
