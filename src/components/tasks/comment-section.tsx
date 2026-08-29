'use client';

/**
 * 评论区 —— 《开发文档-项目管理系统重构》§8.2③ / §7.9
 * 任务抽屉「评论」区：消息流 + 输入框 @ 联想（输入 @ 弹出项目成员选择，
 * 选中写入 mentions 数组随评论提交 → 服务端生成 MENTION 通知 + 待办）。
 */

import { useMemo, useRef, useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/services/api-instance'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { AtSign, CornerDownRight, Send, Trash2 } from 'lucide-react'
import { TaskDetail, UserBrief } from './types'

/**
 * 删除显隐（删除工程第 3 棒 D5）：作者本人 或 PM/ADMIN（canModerate 由抽屉传入；
 * 服务端终审，前端仅按提示显隐）。
 */
export function CommentSection({
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
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 已 @ 的成员（随评论提交） */
  const [mentions, setMentions] = useState<UserBrief[]>([])
  /** @ 联想弹层状态：query 为 @ 后输入的过滤词 */
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  /** 删除中状态（按评论 id） */
  const [deleting, setDeleting] = useState<string | null>(null)

  const comments = task.comments ?? []
  const candidates = useMemo(() => {
    const list = task.mentionCandidates ?? []
    // 已 @ 过的不再重复出现
    const mentionedIds = new Set(mentions.map((m) => m.id))
    return list.filter((c) => !mentionedIds.has(c.id))
  }, [task.mentionCandidates, mentions])

  /** 输入处理：检测光标前最近的未闭合 @ 触发联想 */
  const handleInput = (value: string) => {
    setText(value)
    const el = inputRef.current
    if (!el) return
    const caret = el.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const atIdx = before.lastIndexOf('@')
    if (atIdx === -1) {
      setAtQuery(null)
      return
    }
    const query = before.slice(atIdx + 1)
    // @ 后到光标之间不允许空白（视为已闭合）
    if (/\s/.test(query)) {
      setAtQuery(null)
      return
    }
    setAtQuery(query)
  }

  const pickMention = (u: UserBrief & { title?: string | null }) => {
    setMentions((prev) => (prev.some((m) => m.id === u.id) ? prev : [...prev, u]))
    // 把 @query 替换为 @名字 
    const el = inputRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const atIdx = before.lastIndexOf('@')
    const after = text.slice(caret)
    const next = `${before.slice(0, atIdx)}@${u.name} ${after}`
    setText(next)
    setAtQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = atIdx + u.name.length + 2
      el?.setSelectionRange(pos, pos)
    })
  }

  /** 点击弹层外部关闭 */
  useEffect(() => {
    if (atQuery === null) return
    const onClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setAtQuery(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [atQuery])

  const filtered =
    atQuery === null
      ? []
      : candidates.filter(
          (c) => c.name.toLowerCase().includes(atQuery.toLowerCase())
            || (c.email ?? '').toLowerCase().includes(atQuery.toLowerCase()),
        )

  const submit = async () => {
    if (!text.trim()) {
      toast({ title: '评论内容不能为空', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const res = await api.post(`/tasks/${task.id}/comments`, {
        content: text.trim(),
        ...(mentions.length > 0 ? { mentions: mentions.map((m) => m.id) } : {}),
      })
      setText('')
      setMentions([])
      toast({
        title: '评论已发表',
        description: res.data?.message,
      })
      onMutated()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
        || (e as Error).message
      toast({ title: '发表失败', description: msg, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const askDelete = (commentId: string, preview: string) => {
    confirm.ask(
      '删除评论',
      `将永久删除该评论（「${preview}」），删除后不可恢复，操作将记入审计日志。`,
      async () => {
        setDeleting(commentId)
        try {
          await api.delete(`/tasks/${task.id}/comments/${commentId}`)
          toast({ title: '评论已删除' })
          onMutated()
        } catch (e: unknown) {
          const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
            || (e as Error).message
          toast({ title: '删除失败', description: msg, variant: 'destructive' })
        } finally {
          setDeleting(null)
        }
      },
      { destructive: true, confirmText: '删除' },
    )
  }

  const renderContent = (content: string, mentionedIds: string[] | null) => {
    if (!mentionedIds || mentionedIds.length === 0) {
      return <span className="whitespace-pre-wrap">{content}</span>
    }
    // 高亮被 @ 的成员名
    const names = (task.mentionCandidates ?? []).filter((c) => mentionedIds.includes(c.id)).map((c) => c.name)
    if (names.length === 0) return <span className="whitespace-pre-wrap">{content}</span>
    const pattern = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g')
    const parts = content.split(pattern)
    return (
      <span className="whitespace-pre-wrap">
        {parts.map((p, i) =>
          p.startsWith('@') && names.includes(p.slice(1)) ? (
            <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">{p}</span>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </span>
    )
  }

  return (
    <div className="flex h-full flex-col space-y-3">
      {/* 消息流 */}
      <div className="space-y-3">
        {comments.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-4 text-center text-sm text-muted-foreground">
            暂无评论 —— 输入 @ 可提醒项目成员并生成其待办
          </div>
        ) : (
          comments.map((c) => {
            const canDelete = !task.project.isArchived && (c.userId === currentUserId || canModerate)
            const preview = c.content.length > 30 ? `${c.content.slice(0, 30)}…` : c.content
            return (
            <div key={c.id} className="group flex gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium ${
                  c.userId === currentUserId ? 'bg-primary/15 text-primary' : ''
                }`}
              >
                {(c.user?.name ?? '?').slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1 rounded-lg border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{c.user?.name ?? '—'}</span>
                  <span>{new Date(c.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                  {canDelete && (
                    <button
                      type="button"
                      className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                      disabled={deleting === c.id}
                      onClick={() => askDelete(c.id, preview)}
                      aria-label="删除评论"
                      title="删除评论（作者/PM）"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 text-sm">{renderContent(c.content, c.mentions)}</div>
              </div>
            </div>
            )
          })
        )}
      </div>

      {/* 输入区（任务 view 即可评论，§7.6） */}
      {!task.project.isArchived && (
        <div className="relative mt-auto space-y-2">
          {/* 已 @ 徽条 */}
          {mentions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <AtSign className="h-3 w-3 text-muted-foreground" />
              {mentions.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary"
                >
                  {m.name}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setMentions((prev) => prev.filter((x) => x.id !== m.id))}
                    aria-label={`移除对 ${m.name} 的 @`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="relative" ref={popupRef}>
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={2}
              placeholder="写评论… 输入 @ 提醒成员（Ctrl+Enter 发送）"
              className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
            />
            {/* @ 联想弹层 */}
            {atQuery !== null && filtered.length > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-1 max-h-52 w-64 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
                {filtered.slice(0, 8).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => pickMention(u)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs">
                      {(u.name ?? '?').slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{u.name}</span>
                      {u.title && (
                        <span className="block truncate text-xs text-muted-foreground">{u.title}</span>
                      )}
                    </span>
                    <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>@ 提醒后将通知对方并生成待办</span>
            <Button size="sm" disabled={submitting || !text.trim()} onClick={submit}>
              <Send className="mr-1 h-3 w-3" />
              {submitting ? '发送中…' : '发送'}
            </Button>
          </div>
        </div>
      )}

      {confirm.render}
    </div>
  )
}
