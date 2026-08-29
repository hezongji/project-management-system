'use client'

/**
 * 标注列表 —— 《开发文档-项目管理系统重构》§8.2③
 * 任务抽屉「标注」区：彩色便签（yellow/red/blue/green 底色）+ 解决/重开操作。
 * 权限：解决 = 标注本人 或 任务 edit（§7.6，服务端终审；前端仅按提示显隐）。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/services/api-instance'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { StickyNote, Check, Undo2, Trash2 } from 'lucide-react'
import { TaskDetail, TaskAnnotationItem, AnnotationColor, FIELD_LABELS } from './types'

const COLOR_STYLE: Record<AnnotationColor, string> = {
  yellow: 'bg-yellow-100 border-yellow-300 dark:bg-yellow-950/50 dark:border-yellow-800',
  red: 'bg-red-100 border-red-300 dark:bg-red-950/50 dark:border-red-800',
  blue: 'bg-blue-100 border-blue-300 dark:bg-blue-950/50 dark:border-blue-800',
  green: 'bg-green-100 border-green-300 dark:bg-green-950/50 dark:border-green-800',
}

const COLOR_DOT: Record<AnnotationColor, string> = {
  yellow: 'bg-yellow-400',
  red: 'bg-red-400',
  blue: 'bg-blue-400',
  green: 'bg-green-400',
}

const COLORS: AnnotationColor[] = ['yellow', 'red', 'blue', 'green']
const COLOR_LABEL: Record<AnnotationColor, string> = {
  yellow: '黄',
  red: '红',
  blue: '蓝',
  green: '绿',
}

/**
 * 删除显隐（删除工程第 3 棒 D4）：作者本人 或 PM/ADMIN（canModerate 由抽屉传入：
 * ADMIN 或任务 edit 权限；服务端终审，前端仅按提示显隐，同既有解决按钮模式）。
 */
export function AnnotationList({
  task,
  currentUserId,
  canModerate = false,
  onMutated,
}: {
  task: TaskDetail
  currentUserId: string
  canModerate?: boolean
  onMutated: () => void
}) {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [note, setNote] = useState('')
  const [color, setColor] = useState<AnnotationColor>('yellow')
  const [field, setField] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [operating, setOperating] = useState<string | null>(null)

  const annotations = task.annotations ?? []
  const canAnnotate = task.permissions?.view === true && !task.project.isArchived
  const canEditTask = task.permissions?.edit === true

  const addAnnotation = async () => {
    if (!note.trim()) {
      toast({ title: '请填写批注内容', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      await api.post(`/tasks/${task.id}/annotations`, {
        note: note.trim(),
        color,
        ...(field ? { field } : {}),
      })
      setNote('')
      toast({ title: '标注已添加' })
      onMutated()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '添加失败', description: msg, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const toggleResolve = async (a: TaskAnnotationItem) => {
    setOperating(a.id)
    try {
      await api.patch(`/annotations/${a.id}`, { resolved: !a.resolved })
      toast({ title: a.resolved ? '标注已重新打开' : '标注已解决' })
      onMutated()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '操作失败', description: msg, variant: 'destructive' })
    } finally {
      setOperating(null)
    }
  }

  const askDelete = (a: TaskAnnotationItem) => {
    const preview = a.note.length > 30 ? `${a.note.slice(0, 30)}…` : a.note
    confirm.ask(
      '删除标注',
      `将永久删除该便签（「${preview}」），删除后不可恢复，操作将记入审计日志。`,
      async () => {
        setOperating(a.id)
        try {
          await api.delete(`/annotations/${a.id}`)
          toast({ title: '标注已删除' })
          onMutated()
        } catch (e: unknown) {
          const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
            || (e as Error).message
          toast({ title: '删除失败', description: msg, variant: 'destructive' })
        } finally {
          setOperating(null)
        }
      },
      { destructive: true, confirmText: '删除' },
    )
  }

  return (
    <div className="space-y-3">
      {/* 便签列表 */}
      {annotations.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-4 text-center text-sm text-muted-foreground">
          暂无标注 —— 对任务字段贴一条彩色便签提醒协作者
        </div>
      ) : (
        <ul className="space-y-2">
          {annotations.map((a) => {
            const mine = a.userId === currentUserId
            const canOperate = canEditTask || mine
            const canDelete = !task.project.isArchived && (mine || canModerate)
            return (
              <li
                key={a.id}
                className={`group rounded-md border p-3 text-sm ${COLOR_STYLE[a.color] ?? COLOR_STYLE.yellow} ${
                  a.resolved ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StickyNote className="h-3 w-3" />
                      <span className="font-medium text-foreground/80">{a.user?.name ?? '—'}</span>
                      {a.field && (
                        <span className="rounded bg-white/60 px-1.5 py-0.5 dark:bg-black/30">
                          锚点：{FIELD_LABELS[a.field] ?? a.field}
                        </span>
                      )}
                      <span>{new Date(a.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                    <p className={`mt-1 whitespace-pre-wrap ${a.resolved ? 'line-through' : ''}`}>
                      {a.note}
                    </p>
                  </div>
                  {(canOperate || canDelete) && (
                    <div className="flex shrink-0 items-center gap-1">
                      {canOperate && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 bg-white/50 dark:bg-black/20"
                          disabled={operating === a.id}
                          onClick={() => toggleResolve(a)}
                        >
                          {a.resolved ? <Undo2 className="mr-1 h-3 w-3" /> : <Check className="mr-1 h-3 w-3" />}
                          {a.resolved ? '重开' : '解决'}
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-muted-foreground transition hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                          disabled={operating === a.id}
                          onClick={() => askDelete(a)}
                          aria-label="删除标注"
                          title="删除标注（作者/PM）"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* 添加标注（任务 view 即可，§7.6） */}
      {canAnnotate && (
        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={COLOR_LABEL[c]}
                onClick={() => setColor(c)}
                className={`h-5 w-5 rounded-full border-2 transition ${
                  COLOR_DOT[c]
                } ${color === c ? 'border-foreground ring-2 ring-ring' : 'border-transparent'}`}
                aria-label={`选择${COLOR_LABEL[c]}色便签`}
              />
            ))}
            <select
              value={field}
              onChange={(e) => setField(e.target.value)}
              className="ml-auto h-7 rounded-md border border-input bg-background px-3 text-xs"
            >
              <option value="">锚点：整任务</option>
              {['title', 'description', 'status', 'priority', 'assignee', 'dueDate'].map((f) => (
                <option key={f} value={f}>
                  {FIELD_LABELS[f] ?? f}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="写批注…（如：这个截止日期需要与客户确认）"
            rows={2}
            className="w-full resize-none rounded border bg-background px-2 py-1.5 text-sm"
          />
          <div className="flex justify-end pt-2">
            <Button size="sm" disabled={submitting || !note.trim()} onClick={addAnnotation}>
              {submitting ? '添加中…' : '贴便签'}
            </Button>
          </div>
        </div>
      )}

      {confirm.render}
    </div>
  )
}
