'use client'

import { PageGuard } from '@/components/layout/page-guard'
/**
 * /messages —— 依据《开发文档-项目管理系统重构》§8.2⑥（IM 完整化）
 *
 * 会话列表（未读红点 + 最近排序）+ 聊天窗（全类型气泡 / 引用 / @提及 / 撤回 / 已读 / 卡片跳转）。
 *
 * 数据流：
 *   - 会话列表：GET /api/conversations（unread/lastMessage/members）
 *   - 历史消息：GET /api/conversations/:id/messages?limit=50（倒序，本页反转为正序显示）
 *   - 进入会话自动标读：POST /api/conversations/:id/read
 *   - @联想：GET /api/users（id/name）
 *   - 实时：Socket.IO 连 im-server（:3002）message:send / message:new / message:revoke / read:sync
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { io, Socket } from 'socket.io-client'
import { ApiService } from '@/services/api'
import { FileService } from '@/services/file'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn, formatRelativeTime, getInitials } from '@/lib/utils'
import { MessageBubble, ImAvatar } from '@/components/im/message-bubble'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { type MessageItem, previewText } from '@/components/im/utils'
import { IssueForm } from '@/components/im/issue-form'
import ReportForm from '@/components/im/report-form'
import { MemberPicker, type PickerMember } from '@/components/im/member-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { MessageSquare, Send, Hash, Users, Paperclip, X, Plus, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { useFocusHighlight } from '@/hooks/use-focus-highlight'
import { FocusRing } from '@/components/ui/focus-ring'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3002'
const REVOKE_WINDOW_MS = 2 * 60 * 1000

interface ConversationMember {
  userId: string
  name: string
  email: string
  avatar: string | null
  role: string
}

interface LastMessage {
  id: string
  type: string
  content: string
  senderId: string
  senderName: string | null
  revoked: boolean
  createdAt: string
}

interface ConversationItem {
  id: string
  type: string
  name: string | null
  projectId: string | null
  lastMessageAt: string
  unread: number
  myRole: string | null
  lastMessage: LastMessage | null
  members: ConversationMember[]
}

interface UserLite {
  id: string
  name: string
  email: string
  avatar: string | null
}

function MessagesPageInner() {
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const { toast } = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<MessageItem | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [readUserIds, setReadUserIds] = useState<Record<string, string[]>>({})
  const [uploading, setUploading] = useState(false)
  // P2-7：上传前由用户选择目标目录（替代旧 groups[0].catalogId hack）
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [uploadCatalogs, setUploadCatalogs] = useState<{ id: string; name: string; depth: number }[]>([])
  const [uploadCatalogId, setUploadCatalogId] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [issueOpen, setIssueOpen] = useState(false)
  // ★ AI 会议纪要（S4）：POST /api/ai/meeting-minutes
  const [mmBusy, setMmBusy] = useState(false)
  const [mmResult, setMmResult] = useState<{
    title: string
    summary: string
    decisions: string[]
    actionItems: Array<{ content: string; assigneeName?: string; due?: string | null }>
    actionItemCount: number
    notifiedCount: number
    fileRequirementId: string | null
  } | null>(null)
  const runMeetingMinutes = async () => {
    if (!selectedId || mmBusy) return
    setMmBusy(true)
    try {
      const res = await ApiService.post<typeof mmResult>(
        '/ai/meeting-minutes',
        { conversationId: selectedId },
        { timeout: 120_000 },
      )
      setMmResult(res.data ?? null)
      toast({
        description: `纪要已存入项目文件${res.data?.notifiedCount ? `，已通知 ${res.data.notifiedCount} 人` : ''}`,
      })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '生成会议纪要失败',
      })
    } finally {
      setMmBusy(false)
    }
  }
  const [reportOpen, setReportOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [creatingConv, setCreatingConv] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const meId = user?.id

  // ── 会话列表 ──
  const { data: convsData, isLoading: convsLoading } = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await ApiService.get<ConversationItem[]>('/conversations')).data ?? [],
    refetchInterval: 10000,
  })
  const conversations = convsData ?? []

  // ── 当前会话历史消息（倒序返回 → 反转为正序显示）──
  const { data: msgsData, isLoading: msgsLoading } = useQuery({
    queryKey: ['conversation-messages', selectedId],
    queryFn: async () => {
      const res = await ApiService.get<{ items: MessageItem[] }>(
        `/conversations/${selectedId}/messages?limit=50`,
      )
      return [...(res.data?.items ?? [])].reverse()
    },
    enabled: !!selectedId,
  })
  const messages = msgsData ?? []
  const current = conversations.find((c) => c.id === selectedId) ?? null

  // ── @联想数据源：GET /api/users ──
  const { data: usersData } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await ApiService.get<UserLite[]>('/users')).data ?? [],
  })
  const users = usersData ?? []
  const nameToId = useMemo(() => {
    const m: Record<string, string> = {}
    for (const u of users) if (u.name) m[u.name] = u.id
    return m
  }, [users])

  // ── 跨页定位：?focus=<消息id> 高亮定位；?conversation=<会话id> 仅选会话（两者 id 语义不同，分开取）──
  const searchParams = useSearchParams()
  const urlFocusMsgId = searchParams.get('focus')
  const urlConvId = searchParams.get('conversation')
  const { srcLabel, clearFocus } = useFocusHighlight(['conversation'])

  // ── URL ?conversation= 参数：列表加载后存在才自动选中（issues 通知 link 跳转用；
  //    加载完仍不存在则放弃，避免 10s 轮询反复抢焦点）──
  const urlConvConsumed = useRef(false)
  useEffect(() => {
    if (!urlConvId || urlConvConsumed.current) return
    if (conversations.some((c) => c.id === urlConvId)) {
      urlConvConsumed.current = true
      setSelectedId(urlConvId)
    } else if (!convsLoading && conversations.length > 0) {
      urlConvConsumed.current = true // 坏链容错：列表已加载完仍无此会话
    }
  }, [urlConvId, conversations, convsLoading])

  // ── Socket.IO（im-server :3002）──
  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = localStorage.getItem('auth-token')
    if (!token) return
    const socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
    })
    socketRef.current = socket

    socket.on('message:new', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (selectedIdRef.current) {
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', selectedIdRef.current] })
      }
    })

    // 其他成员拉我进新会话（单聊/群聊/拉人）→ 刷新会话列表
    socket.on('conv:created', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    })

    socket.on('read:sync', (payload: { conversationId?: string; userIds?: string[] }) => {
      const cid = payload?.conversationId
      if (!cid) return
      const ids = Array.isArray(payload.userIds) ? payload.userIds : []
      setReadUserIds((prev) => {
        const existing = prev[cid] ?? []
        const merged = Array.from(new Set([...existing, ...ids]))
        return { ...prev, [cid]: merged }
      })
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [queryClient])

  // 同步 selectedId 到 ref（供 socket 回调读取最新值）
  useEffect(() => {
    selectedIdRef.current = selectedId
    // 切换会话重置输入态
    setDraft('')
    setReplyTo(null)
    setMention(null)
  }, [selectedId])

  // ── 进入会话自动标读（§8.2）+ 已读回执初始化 ──
  useEffect(() => {
    if (!selectedId) return
    if (meId) {
      setReadUserIds((prev) => {
        const existing = prev[selectedId] ?? []
        if (existing.includes(meId)) return prev
        return { ...prev, [selectedId]: [...existing, meId] }
      })
    }
    ApiService.post(`/conversations/${selectedId}/read`, {})
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => {})
  }, [selectedId, meId, queryClient])

  // 每 30s 刷新 now，用于撤回按钮 2 分钟窗口过期
  useEffect(() => {
    if (!selectedId) return
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [selectedId])

  // 滚动到底部（定位消息时不抢滚动，由 FocusRing 滚到目标消息）
  useEffect(() => {
    if (urlFocusMsgId) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, selectedId, urlFocusMsgId])

  const extractMentions = (text: string): string[] => {
    const ids: string[] = []
    const re = /@([^\s@]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const id = nameToId[m[1]]
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  const send = () => {
    const content = draft.trim()
    if (!content || !selectedId || !socketRef.current) return
    // F-005 修复①: 断连时拦截发送并提示，防静默丢失
    if (!socketRef.current.connected) {
      toast({ variant: 'destructive', description: '消息服务连接中，请稍后重发（原文已保留）' })
      return
    }
    const mentionedIds = extractMentions(content)
    socketRef.current.emit(
      'message:send',
      {
        conversationId: selectedId,
        type: 'TEXT',
        content,
        replyToId: replyTo?.id ?? null,
        mentions: mentionedIds.length ? mentionedIds : null,
      },
      (ack?: { ok?: boolean; error?: string }) => {
        if (ack && ack.ok === false) {
          toast({ variant: 'destructive', description: ack.error || '发送失败' })
          setDraft(content) // F-005 修复②: ack 失败恢复草稿防丢字
        }
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', selectedId] })
      },
    )
    setDraft('')
    setReplyTo(null)
    setMention(null)
  }

  const handleRevoke = (m: MessageItem) => {
    if (!socketRef.current) return
    socketRef.current.emit('message:revoke', { messageId: m.id }, (ack?: { ok?: boolean; error?: string }) => {
      if (ack && ack.ok === false) {
        toast({ variant: 'destructive', description: ack.error || '撤回失败' })
      }
      queryClient.invalidateQueries({ queryKey: ['conversation-messages', selectedId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    })
  }

  // ── 解散会话（删除工程第5棒）：仅群主，DELETE /api/conversations/:id ──
  const confirm = useConfirm()
  const handleDissolve = () => {
    if (!current) return
    confirm.ask(
      '解散该会话？',
      `将删除会话「${current.name || '会话'}」的全部成员与历史消息，该操作不可恢复`,
      async () => {
        try {
          await ApiService.delete(`/conversations/${current.id}`)
          toast({ description: '会话已解散' })
          setSelectedId(null)
          queryClient.invalidateQueries({ queryKey: ['conversations'] })
        } catch (e: any) {
          toast({ variant: 'destructive', description: e?.response?.data?.error?.message || '解散失败' })
        }
      },
      { confirmText: '解散', destructive: true },
    )
  }

  // ── @提及 联想 ──
  const detectMention = (text: string, cursor: number) => {
    const before = text.slice(0, cursor)
    const match = before.match(/@([^\s@]*)$/)
    if (match) {
      setMention({ query: match[1], start: cursor - match[0].length })
      setMentionIndex(0)
    } else {
      setMention(null)
    }
  }

  const syncCursor = () => {
    const ta = taRef.current
    if (!ta) return
    detectMention(draft, ta.selectionStart ?? draft.length)
  }

  const mentionCandidates = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return users.filter((u) => u.name && (q === '' || u.name.toLowerCase().includes(q))).slice(0, 8)
  }, [mention, users])

  const selectMention = (u: UserLite) => {
    if (!mention || !u.name) return
    const insert = `@${u.name} `
    const newText =
      draft.slice(0, mention.start) + insert + draft.slice(mention.start + 1 + mention.query.length)
    setDraft(newText)
    setMention(null)
    const pos = mention.start + insert.length
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }

  const onDraftKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(mentionCandidates[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // ── 图片/文件上传（可选，走 /files/upload 后以 IMAGE/FILE 发送 fileMeta）──
  // ── 图片/文件上传（P2-7：先选目录再上传，走 /files/upload 后以 IMAGE/FILE 发送 fileMeta）──
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !selectedId || !socketRef.current) return
    const projectId = current?.projectId ?? null
    if (!projectId) {
      toast({ variant: 'destructive', description: '该会话未关联项目，暂不支持上传文件' })
      return
    }
    try {
      // 拉取项目目录树并拉平（带层级），供用户显式选择上传目录，替代旧 groups[0].catalogId hack
      const tree = await ApiService.get<{
        items?: { id: string; name: string; children: unknown[] }[]
      }>(`/projects/${projectId}/catalogs`)
      const flat: { id: string; name: string; depth: number }[] = []
      const walk = (nodes: { id: string; name: string; children: unknown[] }[] | undefined, depth: number) => {
        nodes?.forEach((n) => {
          flat.push({ id: n.id, name: n.name, depth })
          walk(n.children as { id: string; name: string; children: unknown[] }[], depth + 1)
        })
      }
      walk(tree.data?.items, 0)
      if (flat.length === 0) {
        toast({ variant: 'destructive', description: '项目暂无文件目录，无法上传' })
        return
      }
      setUploadCatalogs(flat)
      setUploadCatalogId(flat[0].id)
      setPendingFile(file)
    } catch {
      toast({ variant: 'destructive', description: '获取文件目录失败，请稍后再试' })
    }
  }

  const confirmUpload = async () => {
    const file = pendingFile
    if (!file || !selectedId || !socketRef.current || !uploadCatalogId) return
    setUploading(true)
    try {
      const up = await FileService.uploadPlanFile(uploadCatalogId, file)
      const f = up.data?.file
      if (!f) throw new Error('上传失败')
      const isImage = file.type.startsWith('image/')
      socketRef.current.emit(
        'message:send',
        {
          conversationId: selectedId,
          type: isImage ? 'IMAGE' : 'FILE',
          content: '',
          fileMeta: { name: f.name, size: f.size, mimeType: f.mimeType, fileId: f.id },
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['conversations'] })
          queryClient.invalidateQueries({ queryKey: ['conversation-messages', selectedId] })
        },
      )
      setPendingFile(null)
    } catch {
      toast({ variant: 'destructive', description: '上传失败，请检查权限或稍后再试' })
    } finally {
      setUploading(false)
    }
  }

  // ── 发起单聊 / 建群（P0-7）──
  const handleCreateConversation = async (selected: PickerMember[]) => {
    const ids = selected.map((s) => s.id)
    if (ids.length === 0) return
    setCreatingConv(true)
    try {
      const type = ids.length <= 1 ? 'SINGLE' : 'GROUP'
      const res = await ApiService.post<{ id: string }>('/conversations', {
        type,
        memberIds: ids,
      })
      const id = res.data?.id
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (id) setSelectedId(id)
      toast({ description: type === 'SINGLE' ? '单聊已打开' : '群聊已创建' })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '发起聊天失败',
      })
    } finally {
      setCreatingConv(false)
    }
  }

  const messageById = useMemo(() => {
    const m = new Map<string, MessageItem>()
    for (const msg of messages) m.set(msg.id, msg)
    return m
  }, [messages])

  const isGroup = (current?.members.length ?? 0) > 2
  const readOthers = useMemo(() => {
    if (!selectedId) return 0
    return (readUserIds[selectedId] ?? []).filter((id) => id !== meId).length
  }, [readUserIds, selectedId, meId])

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* ── 会话列表 ── */}
      <Card className="flex w-72 shrink-0 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">消息</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            onClick={() => setPickerOpen(true)}
            title="发起聊天"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {convsLoading && <p className="p-4 text-sm text-muted-foreground">加载中…</p>}
          {!convsLoading && conversations.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">暂无会话</p>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedId(c.id)}
              className={cn(
                'flex w-full items-start gap-2 border-b px-3 py-3 text-left transition-colors hover:bg-muted/60',
                selectedId === c.id && 'bg-muted',
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {c.name ? getInitials(c.name) : <Hash className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-sm font-medium">
                    {c.name || c.members.map((m) => m.name).filter(Boolean).join('、') || '会话'}
                  </span>
                  {c.unread > 0 && (
                    <Badge className="h-5 min-w-[18px] rounded-full px-1 text-[10px] leading-none">
                      {c.unread > 99 ? '99+' : c.unread}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {c.lastMessage
                    ? `${c.lastMessage.senderName ?? ''}：${previewText(c.lastMessage.type, c.lastMessage.content)}`
                    : '暂无消息'}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                  {formatRelativeTime(c.lastMessageAt)}
                </p>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* ── 聊天窗 ── */}
      <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            选择左侧会话开始聊天
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <span className="truncate text-sm font-semibold">{current?.name || '会话'}</span>
              <Badge variant="secondary" className="shrink-0">
                <Users className="mr-1 h-3 w-3" />
                {current?.members.length ?? 0}
              </Badge>
              {isGroup && readOthers > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground">{readOthers} 人已读</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {/* 解散会话（删除工程第5棒）：仅群主可见 */}
                {current?.myRole === 'OWNER' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={handleDissolve}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    解散会话
                  </Button>
                )}
                {/* 生成会议纪要（S4，AI） */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={mmBusy}
                  onClick={runMeetingMinutes}
                >
                  {mmBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />}
                  {mmBusy ? '生成中…' : '生成会议纪要'}
                </Button>
                {/* 问题上报 */}
                <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
                  <DialogTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      问题上报
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>问题上报</DialogTitle>
                      <DialogDescription>
                        上报项目问题，将生成问题会话与处理任务
                      </DialogDescription>
                    </DialogHeader>
                    <IssueForm
                      defaultProjectId={current?.projectId ?? undefined}
                      onCancel={() => setIssueOpen(false)}
                      onSuccess={() => {
                        setIssueOpen(false)
                        queryClient.invalidateQueries({ queryKey: ['conversations'] })
                      }}
                    />
                  </DialogContent>
                </Dialog>
                {/* 工作汇报 */}
                <Dialog open={reportOpen} onOpenChange={setReportOpen}>
                  <DialogTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      工作汇报
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-xl">
                    <DialogHeader>
                      <DialogTitle>工作汇报</DialogTitle>
                    </DialogHeader>
                    <ReportForm
                      embedded
                      onSuccess={() => {
                        setReportOpen(false)
                        queryClient.invalidateQueries({ queryKey: ['conversations'] })
                      }}
                    />
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            {/* ── 跨页定位来源提示条（?src= 携带）── */}
            {srcLabel && (
              <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary">已定位 · 来自:{srcLabel}</Badge>
                <button
                  type="button"
                  onClick={clearFocus}
                  title="关闭定位提示"
                  className="ml-auto rounded p-0.5 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {msgsLoading && <p className="text-sm text-muted-foreground">加载消息…</p>}
              {!msgsLoading && messages.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">暂无消息，说点什么吧</p>
              )}
              {messages.map((m) => {
                const mine = m.senderId === meId
                const quoted = m.replyToId ? (messageById.get(m.replyToId) ?? null) : null
                const mentionedMe =
                  Array.isArray(m.mentions) && !!meId && m.mentions.includes(meId)
                const canRevoke =
                  mine && !m.revoked && now - new Date(m.createdAt).getTime() <= REVOKE_WINDOW_MS
                return (
                  <FocusRing key={m.id} id={m.id} focusId={urlFocusMsgId}>
                    <MessageBubble
                      message={m}
                      mine={mine}
                      showName={isGroup && !mine}
                      quoted={quoted}
                      mentionedMe={mentionedMe}
                      canRevoke={canRevoke}
                      onReply={setReplyTo}
                      onRevoke={handleRevoke}
                      projectId={current?.projectId ?? null}
                    />
                  </FocusRing>
                )
              })}
              <div ref={bottomRef} />
            </div>

            {/* 引用回复条 */}
            {replyTo && (
              <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="shrink-0 font-medium text-primary">
                  回复 {replyTo.sender?.name || '成员'}：
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {previewText(replyTo.type, replyTo.content)}
                </span>
                <button type="button" onClick={() => setReplyTo(null)} className="shrink-0 hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 输入区 */}
            <div className="border-t px-3 py-2">
              <div className="relative">
                <Textarea
                  ref={taRef}
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value
                    setDraft(v)
                    detectMention(v, e.target.selectionStart ?? v.length)
                  }}
                  onKeyDown={onDraftKeyDown}
                  onKeyUp={syncCursor}
                  onClick={syncCursor}
                  placeholder="输入消息，回车发送，Shift+Enter 换行，@ 提及成员"
                  rows={2}
                  className="resize-none pr-20"
                />
                {/* @联想下拉 */}
                {mention && mentionCandidates.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-1 w-64 overflow-hidden rounded-md border bg-background shadow-lg">
                    {mentionCandidates.map((u, i) => (
                      <button
                        key={u.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          selectMention(u)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted',
                          i === mentionIndex && 'bg-muted',
                        )}
                      >
                        <ImAvatar name={u.name} className="h-6 w-6 text-[10px]" />
                        <span className="truncate">{u.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={onPickFile}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  title="发送图片/文件"
                >
                  <Paperclip className="h-4 w-4" />
                  {uploading && <span className="ml-1 text-xs">上传中…</span>}
                </Button>
                <Button onClick={send} disabled={!draft.trim()} size="sm">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* ── 上传目录选择弹窗（P2-7）── */}
      <Dialog open={!!pendingFile} onOpenChange={(o) => !o && setPendingFile(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>选择上传目录</DialogTitle>
            <DialogDescription className="break-all">{pendingFile?.name}</DialogDescription>
          </DialogHeader>
          <Select value={uploadCatalogId} onValueChange={setUploadCatalogId}>
            <SelectTrigger>
              <SelectValue placeholder="选择目录" />
            </SelectTrigger>
            <SelectContent>
              {uploadCatalogs.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span style={{ paddingLeft: c.depth * 12 }}>{c.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingFile(null)}>
              取消
            </Button>
            <Button size="sm" disabled={uploading} onClick={confirmUpload}>
              {uploading ? '上传中…' : '上传并发送'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AI 会议纪要结果弹窗（S4）── */}
      <Dialog open={!!mmResult} onOpenChange={(v) => !v && setMmResult(null)}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" /> {mmResult?.title ?? '会议纪要'}
            </DialogTitle>
            <DialogDescription>
              纪要已存入项目文件{mmResult?.notifiedCount ? `，已推送待办/通知 ${mmResult.notifiedCount} 人` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <p className="mb-1 font-medium">摘要</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{mmResult?.summary}</p>
            </div>
            {(mmResult?.decisions?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1 font-medium">结论/决定</p>
                <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                  {mmResult!.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {(mmResult?.actionItems?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1 font-medium">待办事项（{mmResult!.actionItems.length}）</p>
                <ul className="space-y-1">
                  {mmResult!.actionItems.map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-muted-foreground">
                      <Badge variant="outline" className="shrink-0">待办</Badge>
                      <span>
                        {a.content}
                        {a.assigneeName ? `（${a.assigneeName}）` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 发起聊天选人弹窗（P0-7）── */}
      <MemberPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="multi"
        title="发起聊天"
        description="勾选一位成员发起单聊，勾选多位成员创建群聊"
        confirmText={(n) =>
          n <= 1 ? '发起单聊' : `发起群聊（${n} 人）`
        }
        excludeIds={meId ? [meId] : []}
        loading={creatingConv}
        onConfirm={handleCreateConversation}
      />

      {/* 解散会话二次确认（删除工程第5棒） */}
      {confirm.render}
    </div>
  )
}


export default function MessagesPage() {
  return (
    <PageGuard pageKey="messages">
      {/* useSearchParams/useFocusHighlight 须 Suspense 包裹（Next.js 预渲染约束） */}
      <Suspense fallback={null}>
        <MessagesPageInner />
      </Suspense>
    </PageGuard>
  )
}
