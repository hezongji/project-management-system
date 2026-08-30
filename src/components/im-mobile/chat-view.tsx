'use client'

/**
 * 移动端聊天视图（微信式，W2 2026-08-29）
 *
 * 顶部栏（返回+标题点击开成员抽屉）/ 气泡区（滚动策略：上翻暂停滚底+新消息 pill）/
 * 长按菜单（复制/回复/撤回）/ 底部输入栏（+面板、emoji、@联想、发送）/
 * 上传流（会话项目目录树选择，W3 将升级为项目选择器）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { FileService } from '@/services/file'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { MessageBubble, ImAvatar } from '@/components/im/message-bubble'
import { type MessageItem } from '@/components/im/utils'
import {
  useConversations,
  useChatSocket,
  useMessages,
  type ConversationItem,
} from '@/components/im/use-im-hooks'
import { MemberDrawer } from './member-drawer'
import { ImageViewer } from './image-viewer'
import { ArrowLeft, Plus, Smile, Send, Image as ImageIcon, FileText, Camera, X, Copy, Reply, Undo2, Trash2, CheckSquare, Mic, Keyboard, Megaphone } from 'lucide-react'

const REVOKE_WINDOW_MS = 2 * 60 * 1000

/** 时间分隔线标签（昨天/今天 HH:mm/日期） */
function formatDividerTime(d: Date) {
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, now)) return hhmm
  const y = new Date(now.getTime() - 86400000)
  if (sameDay(d, y)) return `昨天 ${hhmm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

// 常用 emoji 分类（微信式面板）
const EMOJI_GROUPS: Array<{ label: string; items: string[] }> = [
  {
    label: '笑脸',
    items: ['😀','😁','😂','🤣','😊','😍','🤔','😅','😭','😡','😴','🥱','🤯','🥳','😎','🤩','😇','🙃','😉','😜'],
  },
  {
    label: '手势',
    items: ['👍','👎','👏','🙏','💪','🤝','👌','✌️','🤞','👋','🫡','🙌','👊','✊','🤙','🖐️'],
  },
  {
    label: '生活',
    items: ['☕','🍵','🍺','🍚','🍜','🍰','🎂','🎉','🎊','🎁','❤️','💔','⭐','🔥','🌈','☀️','🌙','❄️','🌊','🏠'],
  },
  {
    label: '符号',
    items: ['✅','❌','❗','❓','💡','📌','📎','📁','📊','📈','💰','🏆','🚀','⏰','📅','📞','✈️','🎯','🔒','🔑'],
  },
]

interface UserLite {
  id: string
  name: string
  email: string
  avatar: string | null
}

/** 长按 hook：500ms 阈值 + 12px 移动取消 */
function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
      timer.current = setTimeout(() => onLongPress(t.clientX, t.clientY), 500)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (Math.abs(t.clientX - start.current.x) > 12 || Math.abs(t.clientY - start.current.y) > 12) {
        if (timer.current) clearTimeout(timer.current)
      }
    },
    onTouchEnd: () => {
      if (timer.current) clearTimeout(timer.current)
    },
    onTouchCancel: () => {
      if (timer.current) clearTimeout(timer.current)
    },
  }
  return handlers
}

export function ChatView({
  conversation,
  onBack,
  onConversationChanged,
}: {
  conversation: ConversationItem
  onBack: () => void
  onConversationChanged: () => void
}) {
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const { toast } = useToast()
  const selectedId = conversation.id
  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const { conversations: convs } = useConversations()
  const { messages, msgsLoading, readUserIds, setReadUserIds, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(selectedId, user?.id)
  const { socketRef, sendText, sendFileMessage, sendVoiceMessage, revoke } = useChatSocket({
    selectedIdRef,
    onMessagesUpdate: (cid) => queryClient.invalidateQueries({ queryKey: ['conversation-messages', cid] }),
    onConversationsUpdate: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onConversationChanged()
    },
    setReadUserIds,
  })

  // ── 编辑器态 ──
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<MessageItem | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [plusOpen, setPlusOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiGroup, setEmojiGroup] = useState(0)
  const [memberOpen, setMemberOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [ctxMenu, setCtxMenu] = useState<{ msg: MessageItem; x: number; y: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // v1.2 W4：本地删除（渲染层过滤，localStorage，500 条截断）
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem('im-deleted-ids') || '[]')
      return new Set(Array.isArray(arr) ? arr : [])
    } catch {
      return new Set()
    }
  })
  const persistDeleted = (s: Set<string>) => {
    const arr = Array.from(s).slice(-500)
    localStorage.setItem('im-deleted-ids', JSON.stringify(arr))
    setDeletedIds(new Set(arr))
  }
  // v1.2 W4：多选模式
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [inputMode, setInputMode] = useState<'text' | 'voice'>('text')
  // v1.2 W6：图片全屏浏览
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // v1.2 W6：群公告
  const [announceOpen, setAnnounceOpen] = useState(false)
  const [announceDraft, setAnnounceDraft] = useState('')
  const [announceCollapsed, setAnnounceCollapsed] = useState(false)
  const [announceBusy, setAnnounceBusy] = useState(false)

  const publishAnnouncement = async () => {
    const content = announceDraft.trim()
    if (!content) return
    setAnnounceBusy(true)
    try {
      await ApiService.patch(`/conversations/${selectedId}/announcement`, { content })
      toast({ description: '群公告已发布' })
      setAnnounceOpen(false)
      setAnnounceDraft('')
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '发布失败',
      })
    } finally {
      setAnnounceBusy(false)
    }
  }
  const [paused, setPaused] = useState(false)
  const [newCount, setNewCount] = useState(0)

  // 上传流（W3：强制项目关联；W6：图片多选 ≤9 张顺序上传）
  // 上传流（v1.2 自动归档：项目群→项目默认目录；普通聊天→聊天记录文件夹）
  const [uploading, setUploading] = useState(false)

  const meId = user?.id
  const current = conversation
  // v1.2 W6：群管理权限（OWNER/ADMIN 或系统管理员）
  const canManage = current.myRole === 'OWNER' || current.myRole === 'ADMIN' || user?.role === 'ADMIN'
  const isGroup = current.type === 'GROUP'
  const readOthers = (readUserIds[selectedId] ?? []).filter((id) => id !== meId).length
  // v1.2：顶部标题——单聊=对方姓名+部门；项目/群聊=会话名（项目名）
  const isSingle = current.type === 'SINGLE' || current.members.length === 2
  const other = current.members.find((m) => m.userId !== meId) ?? current.members[0]
  const headerTitle = isSingle
    ? (other?.name || '成员')
    : (current.name || current.members.map((m) => m.name).filter(Boolean).join('、') || '会话')
  const headerSubtitle = isSingle
    ? (other?.departmentName || '成员')
    : `${current.members.length} 人${isGroup && readOthers > 0 ? ` · ${readOthers} 人已读` : ''}`

  // ── @联想数据源 ──
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

  // ── 撤回窗口计时 ──
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  // ── 滚动策略：上翻暂停滚底，新消息计数 pill ──
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!paused) {
      el.scrollTo({ top: el.scrollHeight })
    } else {
      setNewCount((c) => c + 1)
    }
  }, [messages.length, selectedId, paused])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 上拉加载更早历史（W3）
    if (el.scrollTop < 40 && hasNextPage && !isFetchingNextPage) {
      const prevH = el.scrollHeight
      void fetchNextPage().then(() => {
        requestAnimationFrame(() => {
          const el2 = scrollRef.current
          if (el2) el2.scrollTop = el2.scrollHeight - prevH + el2.scrollTop
        })
      })
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (nearBottom && paused) {
      setPaused(false)
      setNewCount(0)
    } else if (!nearBottom && !paused) {
      setPaused(true)
    }
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPaused(false)
    setNewCount(0)
  }

  // ── 发送 ──
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
    if (!content) return
    let mentionedIds = extractMentions(content)
    // @所有人：mentions 合并全部成员（>20 时服务端守卫只通知不待办）
    if (content.includes('@所有人')) {
      const allIds = current.members.map((m) => m.userId).filter((id) => id !== meId)
      mentionedIds = Array.from(new Set([...mentionedIds, ...allIds]))
    }
    const sent = sendText({
      conversationId: selectedId,
      content,
      replyToId: replyTo?.id ?? null,
      mentions: mentionedIds.length ? mentionedIds : null,
      onAck: (ok, error) => {
        if (!ok) toast({ variant: 'destructive', description: error || '发送失败' })
      },
    })
    if (!sent) return
    setDraft('')
    setReplyTo(null)
    setMention(null)
    scrollToBottom()
  }

  const handleRevoke = (m: MessageItem) => {
    revoke(selectedId, m.id, (ok, error) => {
      if (!ok) toast({ variant: 'destructive', description: error || '撤回失败' })
    })
  }

  // ── @联想 ──
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
  // v1.2 W6：@所有人（联想顶部，>50 人二次确认）
  const selectAllMention = () => {
    if (!mention) return
    const allIds = current.members.map((m) => m.userId).filter((id) => id !== meId)
    const insert = '@所有人 '
    const newText =
      draft.slice(0, mention.start) + insert + draft.slice(mention.start + 1 + mention.query.length)
    setDraft(newText)
    setMention(null)
    // mentions 由 extractMentions 无法解析「所有人」——记录到 ref，send 时用
    mentionAllRef.current = allIds.length > 20 ? null : allIds
    if (allIds.length > 20) {
      toast({ description: `@所有人将通知 ${allIds.length} 名成员（不产生待办）` })
    }
    const pos = mention.start + insert.length
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }
  const mentionAllRef = useRef<string[] | null>(null)
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

  // ── 双击头像 → @（v1.2 W4，群聊）──
  const handleAvatarDoubleTap = (m: MessageItem) => {
    if (!isGroup || !m.sender || m.senderId === meId) return
    const name = m.sender.name
    if (!name) return
    setDraft((d) => {
      const tail = d.endsWith(' ') || d === '' ? '' : ' '
      return d + tail + `@${name} `
    })
    requestAnimationFrame(() => taRef.current?.focus())
  }

  // ── 长按菜单 ──
  const longPress = useLongPress((x, y) => {
    // 通过 data-mid 找长按目标（事件绑定在消息行）
    const el = document.elementFromPoint(x, y)
    const row = el?.closest?.('[data-mid]') as HTMLElement | null
    const mid = row?.dataset.mid
    if (!mid) return
    const msg = messages.find((m) => m.id === mid)
    if (!msg) return
    setCtxMenu({ msg, x, y })
  })
  const copyText = (m: MessageItem) => {
    navigator.clipboard?.writeText(m.content).then(() => {
      toast({ description: '已复制' })
    }).catch(() => {})
    setCtxMenu(null)
  }
  // 本地删除（仅自己不可见）
  const deleteLocal = (m: MessageItem) => {
    const s = new Set(deletedIds)
    s.add(m.id)
    persistDeleted(s)
    toast({ description: '已删除' })
    setCtxMenu(null)
  }
  // 进入多选
  const enterSelect = (m: MessageItem) => {
    setSelectMode(true)
    setSelectedIds(new Set([m.id]))
    setCtxMenu(null)
  }
  // 批量删除
  const deleteSelected = () => {
    const s = new Set(deletedIds)
    selectedIds.forEach((id) => s.add(id))
    persistDeleted(s)
    toast({ description: `已删除 ${selectedIds.size} 条消息` })
    setSelectedIds(new Set())
    setSelectMode(false)
  }
  // 转发（逐条）
  const [forwardOpen, setForwardOpen] = useState(false)
  const forwardSelected = () => {
    if (selectedIds.size === 0) return
    setForwardOpen(true)
  }
  const doForward = async (targetId: string) => {
    const targets = messages.filter((m) => selectedIds.has(m.id))
    let sent = 0
    for (const m of targets) {
      const okSend = sendText({
        conversationId: targetId,
        content: m.type === 'TEXT' ? m.content : '',
        replyToId: null,
        mentions: null,
      })
      // 非文本消息（图片/文件）转发：以 fileMeta 重发
      if (m.type === 'IMAGE' || m.type === 'FILE') {
        sendFileMessage({
          conversationId: targetId,
          file: {
            name: m.fileMeta?.name || '文件',
            size: m.fileMeta?.size || 0,
            mimeType: m.fileMeta?.mimeType || '',
            fileId: m.fileMeta?.fileId || '',
            projectId: m.fileMeta?.projectId,
            projectName: m.fileMeta?.projectName,
            catalogName: m.fileMeta?.catalogName,
          },
          isImage: m.type === 'IMAGE',
        })
      }
      if (okSend) sent++
    }
    toast({ description: `已转发 ${sent} 条消息` })
    setForwardOpen(false)
    setSelectedIds(new Set())
    setSelectMode(false)
  }
  const menuRect = ctxMenu
    ? { left: Math.min(ctxMenu.x, window.innerWidth - 180), top: Math.min(ctxMenu.y, window.innerHeight - 160) }
    : null

  // ── 语音录音（v1.2 W5）──
  const [recording, setRecording] = useState(false)
  const [recordCancel, setRecordCancel] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordCancelRef = useRef(false)
  const sendingRef = useRef(false)

  const pickMimeType = () => {
    if (typeof MediaRecorder === 'undefined') return null
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t
      } catch {
        /* 忽略 */
      }
    }
    return ''
  }

  // 原生录音桥（v1.4：WebView getUserMedia 在部分手机不可用，改安卓原生 MediaRecorder）
  const nativeBridge = typeof window !== 'undefined' ? (window as unknown as { AndroidBridge?: { startRecording?: () => string; stopRecording?: () => string; cancelRecording?: () => void } }).AndroidBridge : undefined

  const base64ToBlob = (b64: string, mime: string) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Blob([arr], { type: mime })
  }

  const startRecord = async () => {
    if (recording || sendingRef.current) return

    // 原生录音（WebView 壳内）
    if (nativeBridge?.startRecording) {
      const r = nativeBridge.startRecording()
      if (r === 'ok') {
        recordCancelRef.current = false
        setRecordCancel(false)
        setRecordSeconds(0)
        setRecording(true)
        recordTimerRef.current = setInterval(() => {
          setRecordSeconds((s) => {
            if (s >= 59) {
              // 60s 自动截断发送
              void finishRecord()
              return s
            }
            return s + 1
          })
        }, 1000)
      } else {
        toast({ variant: 'destructive', description: `录音失败：${r || '未知错误'}` })
      }
      return
    }

    // fallback：Web getUserMedia（浏览器调试用）
    const mime = pickMimeType()
    if (typeof MediaRecorder === 'undefined') {
      toast({
        variant: 'destructive',
        description: '诊断：当前 WebView 不支持 MediaRecorder，请在系统服务里更新「Android System WebView」后重试',
      })
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast({
        variant: 'destructive',
        description: '诊断：麦克风接口不可用（mediaDevices 不存在），请确认已安装最新版 App 且授权麦克风',
      })
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      recordCancelRef.current = false
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (recordTimerRef.current) clearInterval(recordTimerRef.current)
        setRecording(false)
        setRecordSeconds(0)
        const cancelled = recordCancelRef.current
        if (cancelled || sendingRef.current) return
        const blob = new Blob(chunksRef.current, { type: (mime || 'audio/webm').split(';')[0] })
        if (blob.size < 500) {
          toast({ description: '录音太短' })
          return
        }
        if (blob.size > 2 * 1024 * 1024) {
          toast({ variant: 'destructive', description: '录音超过 2MB 限制，请分段录制' })
          return
        }
        await uploadVoice(blob)
      }
      recorderRef.current = rec
      setRecordCancel(false)
      setRecording(true)
      rec.start()
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => {
          if (s >= 59) {
            if (recorderRef.current && recorderRef.current.state === 'recording') recorderRef.current.stop()
            return s
          }
          return s + 1
        })
      }, 1000)
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'NotReadableError') {
        toast({
          variant: 'destructive',
          description: '麦克风被占用或受系统限制。请关闭微信、录音机等正在用麦克风的应用后重试；仍不行请重启手机。',
        })
        return
      }
      if (name === 'NotAllowedError') {
        toast({
          variant: 'destructive',
          description: '麦克风权限被拒绝。请到 系统设置→应用→PM聊天→权限 开启麦克风后重试。',
        })
        return
      }
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      toast({
        variant: 'destructive',
        description: `录音初始化失败（${reason}）`,
      })
    }
  }

  const finishRecord = async () => {
    // 原生录音：停止并上传
    if (nativeBridge?.stopRecording) {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      setRecording(false)
      setRecordSeconds(0)
      if (recordCancelRef.current || sendingRef.current) {
        nativeBridge.cancelRecording?.()
        return
      }
      let res: { ok: boolean; base64?: string; mime?: string; durationMs?: number; error?: string }
      try {
        res = JSON.parse(nativeBridge.stopRecording())
      } catch {
        toast({ variant: 'destructive', description: '录音结束失败' })
        return
      }
      if (res.ok && res.base64) {
        const blob = base64ToBlob(res.base64, res.mime || 'audio/mp4')
        if (blob.size < 500) {
          toast({ description: '录音太短' })
          return
        }
        const dur = Math.max(1, Math.round((res.durationMs || 0) / 1000))
        await uploadVoice(blob, dur)
      } else {
        toast({ variant: 'destructive', description: res.error || '录音失败' })
      }
      return
    }
    // fallback：Web MediaRecorder
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  const uploadVoice = async (blob: Blob, durationSec?: number) => {
    sendingRef.current = true
    try {
      const duration = durationSec ?? Math.max(1, Math.round(blob.size / 16000))
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
      const form = new FormData()
      form.append('file', blob, `voice.${ext}`)
      const { api } = await import('@/services/api')
      // 必须显式 multipart（api 实例默认 application/json，否则 FormData 上传 Content-Type 错误）
      const res = await api.post('/im/voice-upload', form, { headers: { 'Content-Type': 'multipart/form-data' } })
      const voiceId = res.data?.data?.voiceId
      if (!voiceId) throw new Error('上传失败')
      sendVoiceMessage({
        conversationId: selectedId,
        voiceId,
        duration,
        size: blob.size,
        onAck: (ok, error) => {
          if (!ok) toast({ variant: 'destructive', description: error || '语音发送失败' })
        },
      })
      scrollToBottom()
    } catch {
      toast({ variant: 'destructive', description: '语音上传失败' })
    } finally {
      sendingRef.current = false
    }
  }

  // 页面隐藏/来电中断 → 取消录音
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && recording) {
        recordCancelRef.current = true
        if (nativeBridge?.cancelRecording) {
          nativeBridge.cancelRecording()
          if (recordTimerRef.current) clearInterval(recordTimerRef.current)
          setRecording(false)
          setRecordSeconds(0)
        } else {
          finishRecord()
        }
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [recording])
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    if (files.length > 9) {
      toast({ variant: 'destructive', description: '一次最多选择 9 张图片' })
      return
    }
    setPlusOpen(false)
    await uploadFiles(files)
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0 || uploading) return
    setUploading(true)
    try {
      // 自动归档目标：项目群→项目默认目录；普通聊天→聊天记录文件夹
      const tRes = await ApiService.post<{ projectId: string; projectName: string; catalogId: string; catalogName: string }>(
        '/im/upload-target',
        { conversationId: selectedId },
      )
      const target = tRes.data
      if (!target?.catalogId) throw new Error('获取归档目录失败')
      let sent = 0
      for (const file of files) {
        try {
          const up = await FileService.uploadPlanFile(target.catalogId, file)
          const f = up.data?.file
          if (!f) throw new Error('上传失败')
          const isImage = file.type.startsWith('image/')
          sendFileMessage({
            conversationId: selectedId,
            file: {
              name: f.name,
              size: f.size,
              mimeType: f.mimeType,
              fileId: f.id,
              projectId: target.projectId,
              projectName: target.projectName,
              catalogName: target.catalogName,
            },
            isImage,
          })
          sent++
        } catch {
          /* 单张失败继续，结束汇总 */
        }
      }
      if (sent > 0) {
        toast({ description: `已归档到 ${target.projectName} / ${target.catalogName}` })
        scrollToBottom()
      } else {
        toast({ variant: 'destructive', description: '上传失败，请稍后再试' })
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '上传失败，请稍后再试',
      })
    } finally {
      setUploading(false)
    }
  }

  const messageById = useMemo(() => {
    const m = new Map<string, MessageItem>()
    for (const msg of messages) m.set(msg.id, msg)
    return m
  }, [messages])

  // 图片消息 fileId 序列（供全屏浏览）
  const imageFileIds = useMemo(
    () => messages.filter((m) => m.type === 'IMAGE' && m.fileMeta?.fileId).map((m) => m.fileMeta!.fileId as string),
    [messages],
  )
  const openImage = (m: MessageItem) => {
    const idx = imageFileIds.indexOf(m.fileMeta?.fileId as string)
    if (idx >= 0) setViewerIndex(idx)
  }

  // 渲染层过滤（本地删除）+ 时间分隔线（>5min）
  const renderItems = useMemo(() => {
    type Item = { kind: 'divider'; label: string } | { kind: 'msg'; m: MessageItem }
    const items: Item[] = []
    let prev: Date | null = null
    for (const m of messages) {
      if (deletedIds.has(m.id)) continue
      const t = new Date(m.createdAt)
      if (!prev || t.getTime() - prev.getTime() > 5 * 60 * 1000) {
        items.push({ kind: 'divider', label: formatDividerTime(t) })
      }
      items.push({ kind: 'msg', m })
      prev = t
    }
    return items
  }, [messages, deletedIds])

  return (
    <div className="flex h-full flex-col bg-background" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* 顶部栏（多选模式：已选 N 条 + 取消） */}
      <header className="flex shrink-0 items-center gap-1 border-b bg-card px-2 py-2" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {selectMode ? (
          <>
            <span className="flex-1 px-2 text-[15px] font-semibold">已选 {selectedIds.size} 条</span>
            <button
              type="button"
              onClick={() => {
                setSelectMode(false)
                setSelectedIds(new Set())
              }}
              className="flex h-9 shrink-0 items-center rounded px-3 text-sm text-muted-foreground hover:bg-muted"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setMemberOpen(true)}
              className="flex min-w-0 flex-1 flex-col items-center px-1 text-center"
              title="查看成员"
            >
              <span className="w-full truncate text-[16px] font-semibold leading-tight">
                {headerTitle}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {headerSubtitle}
              </span>
            </button>
          </>
        )}
      </header>

      {/* 消息区（微信灰背景） */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[hsl(var(--chat-bg))] px-3 py-3 select-none"
        style={{ WebkitUserSelect: 'none', userSelect: 'none' }}
        onScroll={onScroll}
      >
        {hasNextPage && (
          <p className="py-1 text-center text-[11px] text-muted-foreground">
            {isFetchingNextPage ? '加载更早消息…' : '上滑加载更早消息'}
          </p>
        )}
        {msgsLoading && <p className="text-center text-sm text-muted-foreground">加载消息…</p>}
        {!msgsLoading && renderItems.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">暂无消息，说点什么吧</p>
        )}
        {renderItems.map((item, i) => {
          if (item.kind === 'divider') {
            return (
              <div key={`d${i}`} className="flex justify-center py-1">
                <span className="rounded bg-black/10 px-2.5 py-0.5 text-[10px] text-muted-foreground">
                  {item.label}
                </span>
              </div>
            )
          }
          const m = item.m
          const mine = m.senderId === meId
          const quoted = m.replyToId ? (messageById.get(m.replyToId) ?? null) : null
          const mentionedMe =
            Array.isArray(m.mentions) && !!meId && m.mentions.includes(meId)
          const canRevoke = mine && !m.revoked && now - new Date(m.createdAt).getTime() <= REVOKE_WINDOW_MS
          const checked = selectedIds.has(m.id)
          return (
            <div
              key={m.id}
              data-mid={m.id}
              {...(selectMode ? {} : longPress)}
              onClick={selectMode ? () => setSelectedIds((p) => {
                const s = new Set(p)
                if (s.has(m.id)) s.delete(m.id)
                else s.add(m.id)
                return s
              }) : undefined}
              className={cn('relative flex items-start gap-2', selectMode && 'cursor-pointer')}
            >
              {selectMode && (
                <span
                  className={cn(
                    'mt-4 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                    checked ? 'border-primary bg-primary text-white' : 'border-muted-foreground/40 bg-white',
                  )}
                >
                  {checked && '✓'}
                </span>
              )}
              <div className={cn('min-w-0 flex-1', selectMode && 'pointer-events-none')}>
                <MessageBubble
                  message={m}
                  mine={mine}
                  showName={isGroup && !mine}
                  quoted={quoted}
                  mentionedMe={mentionedMe}
                  canRevoke={canRevoke}
                  onReply={selectMode ? undefined : setReplyTo}
                  onRevoke={selectMode ? undefined : handleRevoke}
                  projectId={current?.projectId ?? null}
                  variant="mobile"
                  onAvatarDoubleTap={selectMode ? undefined : handleAvatarDoubleTap}
                  onImageClick={selectMode ? undefined : openImage}
                />
              </div>
            </div>
          )
        })}
        <div className="h-1" />
      </div>

      {/* 新消息 pill */}
      {paused && newCount > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full bg-primary/90 px-4 py-1.5 text-xs text-primary-foreground shadow-lg"
        >
          {newCount} 条新消息 ↓
        </button>
      )}

      {/* 多选底部操作条 */}
      {selectMode && (
        <div className="flex shrink-0 items-center gap-3 border-t bg-card px-4 py-2">
          <button
            type="button"
            onClick={forwardSelected}
            disabled={selectedIds.size === 0}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary/10 py-2 text-sm font-medium text-primary disabled:opacity-40"
          >
            转发（{selectedIds.size}）
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedIds.size === 0}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-destructive/10 py-2 text-sm font-medium text-destructive disabled:opacity-40"
          >
            删除（{selectedIds.size}）
          </button>
        </div>
      )}

      {/* 引用回复条 */}
      {replyTo && (
        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-primary">回复 {replyTo.sender?.name || '成员'}：</span>
          <span className="min-w-0 flex-1 truncate">{replyTo.content || '[文件]'}</span>
          <button type="button" onClick={() => setReplyTo(null)} className="shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* + 面板 / emoji 面板 */}
      {(plusOpen || emojiOpen) && (
        <div className="shrink-0 border-t bg-card px-4 py-3">
          {plusOpen && (
            <div className="flex gap-6">
              {/* 相册（v1.2 W6：多选 ≤9） */}
              <label className="flex flex-col items-center gap-1 text-muted-foreground">
                <input type="file" accept="image/*" multiple className="hidden" onChange={onPickFile} />
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <ImageIcon className="h-7 w-7" />
                </span>
                <span className="text-[11px]">相册</span>
              </label>
              {/* 拍照 */}
              <label className="flex flex-col items-center gap-1 text-muted-foreground">
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickFile} />
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <Camera className="h-7 w-7" />
                </span>
                <span className="text-[11px]">拍照</span>
              </label>
              {/* 文件 */}
              <label className="flex flex-col items-center gap-1 text-muted-foreground">
                <input type="file" className="hidden" onChange={onPickFile} />
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <FileText className="h-7 w-7" />
                </span>
                <span className="text-[11px]">文件</span>
              </label>
            </div>
          )}
          {emojiOpen && (
            <div>
              <div className="flex gap-4 border-b pb-1">
                {EMOJI_GROUPS.map((g, i) => (
                  <button
                    key={g.label}
                    type="button"
                    onClick={() => setEmojiGroup(i)}
                    className={cn(
                      'px-1 py-1 text-xs',
                      emojiGroup === i ? 'border-b-2 border-primary font-medium text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-8 gap-1 pt-2">
                {EMOJI_GROUPS[emojiGroup].items.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded text-xl active:bg-muted"
                    onClick={() => setDraft((d) => d + e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 底部输入栏 */}
      <div className="flex shrink-0 items-end gap-1 border-t bg-card px-2 py-2">
        {/* 语音切换按钮（v1.2 W5） */}
        <button
          type="button"
          onClick={() => setInputMode((m) => (m === 'text' ? 'voice' : 'text'))}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground"
          title={inputMode === 'text' ? '切换语音' : '切换键盘'}
        >
          {inputMode === 'text' ? <Mic className="h-6 w-6" /> : <Keyboard className="h-6 w-6" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlusOpen((v) => !v)
            setEmojiOpen(false)
          }}
          className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', plusOpen ? 'rotate-45 bg-muted text-primary' : 'text-muted-foreground')}
          title="更多"
        >
          <Plus className="h-6 w-6" />
        </button>
        <div className="relative min-w-0 flex-1">
          {inputMode === 'voice' ? (
            <button
              type="button"
              onContextMenu={(e) => e.preventDefault()}
              style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none', userSelect: 'none', touchAction: 'none' }}
              onTouchStart={() => {
                startRecord()
              }}
              onTouchMove={(e) => {
                const t = e.touches[0]
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const out = rect.bottom - t.clientY > 60
                if (out !== recordCancel) setRecordCancel(out)
                recordCancelRef.current = out
              }}
              onTouchEnd={() => {
                finishRecord()
              }}
              onTouchCancel={() => {
                recordCancelRef.current = true
                finishRecord()
              }}
              className={cn(
                'h-9 w-full rounded-xl text-sm font-medium',
                recording
                  ? recordCancel
                    ? 'bg-destructive/80 text-white'
                    : 'bg-muted text-foreground'
                  : 'bg-muted/60 text-muted-foreground',
              )}
            >
              {recording
                ? recordCancel
                  ? '松开取消'
                  : `录音中 ${recordSeconds}s（松开发送）`
                : '按住 说话'}
            </button>
          ) : (
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
              placeholder="输入消息…"
              rows={1}
              className="h-9 max-h-28 min-h-[36px] resize-none overflow-y-auto rounded-xl bg-muted/60 py-1.5 text-[15px] leading-5"
              style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
            />
          )}
          {mention && mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-0 z-20 mb-1 max-h-52 w-64 overflow-y-auto rounded-lg border bg-card shadow-lg">
              {mention.query === '' && isGroup && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectAllMention()
                  }}
                  className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm font-medium text-primary"
                >
                  <Megaphone className="h-4 w-4" />
                  所有人（{Math.max(current.members.length - 1, 0)} 人）
                </button>
              )}
              {mentionCandidates.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectMention(u)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                    i === mentionIndex && 'bg-muted',
                  )}
                >
                  <ImAvatar name={u.name} avatar={u.avatar} className="h-6 w-6 text-[10px]" />
                  <span className="truncate">{u.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setEmojiOpen((v) => !v)
            setPlusOpen(false)
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground"
          title="表情"
        >
          <Smile className="h-6 w-6" />
        </button>
        <Button onClick={send} disabled={!draft.trim()} size="sm" className="h-9 shrink-0 rounded-lg px-4">
          <Send className="h-4 w-4" />
        </Button>
      </div>

      {/* 长按菜单 */}
      {ctxMenu && menuRect && (
        <div className="fixed inset-0 z-50" onClick={() => setCtxMenu(null)}>
          <div
            className="absolute flex flex-col rounded-xl border bg-card py-1 shadow-xl"
            style={{ left: menuRect.left, top: menuRect.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.msg.type === 'TEXT' && (
              <button
                type="button"
                onClick={() => copyText(ctxMenu.msg)}
                className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
              >
                <Copy className="h-4 w-4" /> 复制
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setReplyTo(ctxMenu.msg)
                setCtxMenu(null)
              }}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
            >
              <Reply className="h-4 w-4" /> 回复
            </button>
            <button
              type="button"
              onClick={() => enterSelect(ctxMenu.msg)}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
            >
              <CheckSquare className="h-4 w-4" /> 多选
            </button>
            <button
              type="button"
              onClick={() => deleteLocal(ctxMenu.msg)}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
            >
              <Trash2 className="h-4 w-4" /> 删除
            </button>
            {ctxMenu.msg.senderId === meId &&
              !ctxMenu.msg.revoked &&
              now - new Date(ctxMenu.msg.createdAt).getTime() <= REVOKE_WINDOW_MS && (
                <button
                  type="button"
                  onClick={() => {
                    handleRevoke(ctxMenu.msg)
                    setCtxMenu(null)
                  }}
                  className="flex items-center gap-2 px-4 py-2.5 text-left text-sm text-destructive hover:bg-muted"
                >
                  <Undo2 className="h-4 w-4" /> 撤回
                </button>
              )}
          </div>
        </div>
      )}

      {/* 转发目标选择（逐条转发） */}
      {forwardOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setForwardOpen(false)}>
          <div
            className="max-h-[70%] w-full overflow-y-auto rounded-t-2xl border-t bg-card p-3 pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-2 pb-2 text-sm font-medium">转发到</p>
            {convs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => doForward(c.id)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted"
              >
                <ImAvatar
                  name={c.name ? undefined : c.members.find((m) => m.userId !== meId)?.name}
                  avatar={c.name ? null : c.members.find((m) => m.userId !== meId)?.avatar}
                  className="h-9 w-9"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {c.name || c.members.map((m) => m.name).filter(Boolean).join('、') || '会话'}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setForwardOpen(false)}
              className="mt-1 w-full rounded-lg py-2 text-center text-sm text-muted-foreground hover:bg-muted"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 群公告编辑弹层（v1.2 W6，仅 OWNER/ADMIN） */}
      {announceOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setAnnounceOpen(false)}>
          <div
            className="w-full rounded-t-2xl border-t bg-card p-4 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="pb-2 text-sm font-semibold">
              {canManage ? '发布群公告' : '群公告'}
            </p>
            {canManage ? (
              <>
                <textarea
                  value={announceDraft}
                  onChange={(e) => setAnnounceDraft(e.target.value)}
                  placeholder="输入公告内容，发布后所有成员可见…"
                  rows={4}
                  className="w-full resize-none rounded-lg border bg-muted/40 p-2.5 text-sm outline-none"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAnnounceOpen(false)}>
                    取消
                  </Button>
                  <Button size="sm" onClick={publishAnnouncement} disabled={announceBusy || !announceDraft.trim()}>
                    {announceBusy ? '发布中…' : '发布'}
                  </Button>
                </div>
              </>
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {current.announcement || '暂无公告'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 图片全屏浏览（v1.2 W6，微信式） */}
      {viewerIndex !== null && imageFileIds.length > 0 && (
        <ImageViewer
          fileIds={imageFileIds}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}

      {/* 群成员抽屉 */}
      <MemberDrawer
        open={memberOpen}
        conversation={current}
        meId={meId}
        onClose={() => setMemberOpen(false)}
        canManage={canManage}
        onEditAnnouncement={() => {
          setMemberOpen(false)
          setAnnounceOpen(true)
        }}
      />
    </div>
  )
}
