'use client'

/**
 * IM 共享逻辑 hooks（W1 抽取，2026-08-29）
 *
 * 桌面 /messages 与移动端 /im 共用。抽取不变量（v4-pro F5）：
 *  ① socket effect 依赖只允许稳定引用；selectedId 走 ref 传入，避免切会话重连
 *  ② read:sync 的 setReadUserIds 以 useState setter 直传（天然稳定）
 *  ③ 编辑器态（draft/replyTo/mention）留在组件层，sendText/revoke/uploadSend 只收参数
 */

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { io, type Socket } from 'socket.io-client'
import { ApiService } from '@/services/api'
import type { MessageItem } from '@/components/im/utils'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3002'

export interface ConversationItem {
  id: string
  type: string
  name: string | null
  projectId: string | null
  lastMessageAt: string
  unread: number
  myRole: string | null
  /** v1.2 W1：会话偏好（服务端），W2/W3 消费；旧接口无此字段时 undefined */
  myPrefs?: {
    isPinned: boolean
    muted: boolean
    hiddenAt: string | null
  }
  /** v1.2 W1：群公告 */
  announcement?: string | null
  announcementAt?: string | null
  lastMessage: {
    id: string
    type: string
    content: string
    senderId: string
    senderName: string | null
    revoked: boolean
    createdAt: string
  } | null
  members: Array<{
    userId: string
    name: string
    email: string
    avatar: string | null
    role: string
    departmentName?: string | null
  }>
}

export function useConversations() {
  const queryClient = useQueryClient()
  const { data: convsData, isLoading: convsLoading, refetch } = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await ApiService.get<ConversationItem[]>('/conversations')).data ?? [],
    refetchInterval: 10000,
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['conversations'] })
  return { conversations: convsData ?? [], convsLoading, invalidate, refetch }
}

/** 同步插入/更新会话缓存（新建会话后跳转前调用，避免 current 找不到回退列表） */
export function upsertConversation(queryClient: ReturnType<typeof useQueryClient>, conv: ConversationItem) {
  queryClient.setQueryData<ConversationItem[]>(['conversations'], (old) => {
    const list = old ?? []
    if (list.some((c) => c.id === conv.id)) return list
    return [conv, ...list]
  })
}

interface ChatSocketOpts {
  /** 当前选中会话 id 的 ref（socket 回调读最新值，避免切会话重连） */
  selectedIdRef: React.RefObject<string | null>
  /** 有会话新消息 → 刷新该会话历史（调用方须保证引用稳定） */
  onMessagesUpdate?: (conversationId: string) => void
  /** 会话列表变更 → 刷新列表（调用方须保证引用稳定） */
  onConversationsUpdate?: () => void
  /** read:sync 回执 setter（useState setter 直传，天然稳定） */
  setReadUserIds: Dispatch<SetStateAction<Record<string, string[]>>>
}

/** Socket 连接 + 收发（sendText/revoke），事件回调经 latestRef 读取（F5 不变量①） */
export function useChatSocket({ selectedIdRef, onMessagesUpdate, onConversationsUpdate, setReadUserIds }: ChatSocketOpts) {
  const queryClient = useQueryClient()
  const socketRef = useRef<Socket | null>(null)
  // 最新回调 ref：effect 依赖保持稳定，回调更新不触发重连/重订阅
  const cbRef = useRef({ onMessagesUpdate, onConversationsUpdate })
  cbRef.current = { onMessagesUpdate, onConversationsUpdate }

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

    // token 失效：im-server 握手返回 unauthorized → 跳登录带 next（W1-I3）
    socket.on('connect_error', (err: Error) => {
      if (err?.message === 'unauthorized') {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?next=${next}`
      }
    })

    socket.on('message:new', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      const sid = selectedIdRef.current
      if (sid) {
        cbRef.current.onMessagesUpdate?.(sid)
      }
    })

    socket.on('conv:created', () => {
      cbRef.current.onConversationsUpdate?.()
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
    // 依赖仅稳定引用（queryClient/setReadUserIds/refs），F5 不变量①
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, setReadUserIds])

  const sendText = (args: {
    conversationId: string
    content: string
    replyToId?: string | null
    mentions?: string[] | null
    onAck?: (ok: boolean, error?: string) => void
  }) => {
    const socket = socketRef.current
    if (!socket) return false
    socket.emit(
      'message:send',
      {
        conversationId: args.conversationId,
        type: 'TEXT',
        content: args.content,
        replyToId: args.replyToId ?? null,
        mentions: args.mentions?.length ? args.mentions : null,
      },
      (ack?: { ok?: boolean; error?: string }) => {
        if (ack && ack.ok === false) args.onAck?.(false, ack.error)
        else args.onAck?.(true)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', args.conversationId] })
      },
    )
    return true
  }

  const sendFileMessage = (args: {
    conversationId: string
    file: {
      name: string
      size: number
      mimeType: string
      fileId: string
      /** 归档归属（v1.1 W3）：项目/目录快照，供文件卡片展示 */
      projectId?: string | null
      projectName?: string | null
      catalogName?: string | null
    }
    isImage: boolean
    onAck?: (ok: boolean, error?: string) => void
  }) => {
    const socket = socketRef.current
    if (!socket) return false
    socket.emit(
      'message:send',
      {
        conversationId: args.conversationId,
        type: args.isImage ? 'IMAGE' : 'FILE',
        content: '',
        fileMeta: {
          name: args.file.name,
          size: args.file.size,
          mimeType: args.file.mimeType,
          fileId: args.file.fileId,
          projectId: args.file.projectId ?? null,
          projectName: args.file.projectName ?? null,
          catalogName: args.file.catalogName ?? null,
        },
      },
      (ack?: { ok?: boolean; error?: string }) => {
        if (ack && ack.ok === false) args.onAck?.(false, ack.error)
        else args.onAck?.(true)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', args.conversationId] })
      },
    )
    return true
  }

  const sendVoiceMessage = (args: {
    conversationId: string
    voiceId: string
    duration: number
    size: number
    onAck?: (ok: boolean, error?: string) => void
  }) => {
    const socket = socketRef.current
    if (!socket) return false
    socket.emit(
      'message:send',
      {
        conversationId: args.conversationId,
        type: 'VOICE',
        content: '',
        fileMeta: { voiceId: args.voiceId, duration: args.duration, size: args.size },
      },
      (ack?: { ok?: boolean; error?: string }) => {
        if (ack && ack.ok === false) args.onAck?.(false, ack.error)
        else args.onAck?.(true)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', args.conversationId] })
      },
    )
    return true
  }

  const revoke = (conversationId: string, messageId: string, onAck?: (ok: boolean, error?: string) => void) => {
    const socket = socketRef.current
    if (!socket) return false
    socket.emit('message:revoke', { messageId }, (ack?: { ok?: boolean; error?: string }) => {
      if (ack && ack.ok === false) onAck?.(false, ack.error)
      else onAck?.(true)
      queryClient.invalidateQueries({ queryKey: ['conversation-messages', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    })
    return true
  }

  return { socketRef, sendText, sendFileMessage, sendVoiceMessage, revoke }
}

/** 会话历史消息（游标倒序分页，useInfiniteQuery）+ 已读回执（readUserIds）+ 进入会话自动标读 */
export function useMessages(selectedId: string | null, meId?: string) {
  const queryClient = useQueryClient()
  const [readUserIds, setReadUserIds] = useState<Record<string, string[]>>({})

  const { data, isLoading: msgsLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['conversation-messages', selectedId],
    queryFn: async ({ pageParam }) => {
      const url = pageParam
        ? `/conversations/${selectedId}/messages?limit=50&before=${pageParam}`
        : `/conversations/${selectedId}/messages?limit=50`
      const res = await ApiService.get<{ items: MessageItem[]; hasMore?: boolean; nextBefore?: string | null }>(url)
      return {
        items: res.data?.items ?? [],
        hasMore: res.data?.hasMore ?? false,
        nextBefore: res.data?.nextBefore ?? null,
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextBefore : undefined),
    enabled: !!selectedId,
  })

  // 每页倒序（最新在前）→ 全量正序拼接（旧→新）
  const messages = useMemo(() => {
    const pages = data?.pages ?? []
    const all: MessageItem[] = []
    for (let i = pages.length - 1; i >= 0; i--) {
      all.push(...[...pages[i].items].reverse())
    }
    return all
  }, [data])

  // 进入会话自动标读 + 已读回执初始化
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

  return { messages, msgsLoading, readUserIds, setReadUserIds, fetchNextPage, hasNextPage, isFetchingNextPage }
}
