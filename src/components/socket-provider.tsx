'use client'

/**
 * 全局 SocketProvider（P4-3）—— 依据《开发文档-项目管理系统重构》§8.2⑥ / §8.3 / §9.2
 *
 * 职责（与 messages 页自连 socket 相互独立，双连接在 presence 层兼容）：
 *   - 连接 **im-server（NEXT_PUBLIC_WS_URL || :3002）**，负责「全局未读计数 + 桌面通知」
 *   - 不渲染消息（消息渲染由 messages 页自连 socket 负责，P4-2 成果不动）
 *
 * 事件处理（§9.2 S→C）：
 *   - connect          → connected=true + 请求通知权限 + 离线补拉（GET /api/conversations 聚合 unread）
 *   - disconnect       → connected=false
 *   - message:new      → senderId≠当前用户时 unreadTotal+1；页面隐藏时弹桌面通知
 *   - notify:push      → addNotification（站内）+ 桌面通知
 *   - todo:push        → 桌面通知
 *   - conv:created     → 刷新会话列表（invalidateQueries conversations）
 *   - presence:sync    → 更新在线列表（可选）
 *
 * 旧的 SOCKET_EVENTS（主服务 :3001 的 NOTIFICATION/ACTIVITY/TASK_* 等）已脱节，移除。
 */

import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { useAuthStore } from '@/store/auth'
import { useAppStore } from '@/store/app'
import { useChatStore } from '@/store/chat'
import { ApiService } from '@/services/api'
import { useQueryClient } from '@tanstack/react-query'
import { notify, requestNotifyPermission } from '@/lib/notify'
import type { Notification } from '@/types'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3002'

interface SocketProviderProps {
  children: React.ReactNode
}

/** 消息正文 → 通知预览文本（非 TEXT 类型只给占位标签） */
function messagePreview(type?: string, content?: string): string {
  if (!type || type === 'TEXT') return content ?? ''
  if (type === 'IMAGE') return '[图片]'
  if (type === 'FILE') return '[文件]'
  return '[卡片消息]'
}

/** 生成临时 id（避免依赖 crypto.randomUUID 的 lib 支持） */
function tempId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function SocketProvider({ children }: SocketProviderProps) {
  const { user, isAuthenticated } = useAuthStore()
  const { addNotification } = useAppStore()
  const setConnected = useChatStore((s) => s.setConnected)
  const incrementUnread = useChatStore((s) => s.incrementUnread)
  const setUnread = useChatStore((s) => s.setUnread)
  const setOnlineUserIds = useChatStore((s) => s.setOnlineUserIds)
  const queryClient = useQueryClient()
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    if (!isAuthenticated || !user) return
    if (typeof window === 'undefined') return

    const token = localStorage.getItem('auth-token')
    if (!token) return

    const currentUser = user
    const meId = currentUser.id

    const socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
    })
    socketRef.current = socket

    // ── connect：连接态 + 权限请求 + 离线补拉未读（§8.2⑥「离线补拉」）──
    socket.on('connect', () => {
      setConnected(true)
      requestNotifyPermission()

      // 登录后聚合未读：GET /api/conversations（列表项已带 unread 字段）
      ApiService.get<Array<{ unread?: number }>>('/conversations')
        .then((res) => {
          const items = res.data ?? []
          const total = items.reduce(
            (sum, c) => sum + (typeof c.unread === 'number' ? c.unread : 0),
            0,
          )
          setUnread(total)
        })
        .catch(() => {
          // 补拉失败不阻断，等待后续 message:new 增量
        })
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    // ── message:new：未读 +1（仅非本人）+ 页面隐藏时桌面通知 ──
    socket.on('message:new', (payload: { message?: { senderId?: string; senderName?: string; type?: string; content?: string }; conversationId?: string }) => {
      const message = payload?.message
      if (!message) return

      if (message.senderId && message.senderId !== meId) {
        incrementUnread(1)
      }

      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        const senderName = message.senderName || '新消息'
        notify(
          senderName,
          messagePreview(message.type, message.content),
          payload.conversationId ? `/messages?conversation=${payload.conversationId}` : '/messages',
        )
      }
    })

    // ── notify:push：站内通知 + 桌面通知 ──
    socket.on('notify:push', (payload: { title?: string; body?: string; link?: string }) => {
      if (!payload) return
      const notif: Notification = {
        id: tempId(),
        type: 'mention',
        title: payload.title ?? '通知',
        message: payload.body ?? '',
        userId: meId,
        user: currentUser,
        isRead: false,
        data: { link: payload.link ?? null },
        createdAt: new Date(),
      }
      addNotification(notif)
      notify(payload.title ?? '通知', payload.body, payload.link)
    })

    // ── todo:push：桌面通知（§9.2，@提及另推的待办）──
    socket.on('todo:push', (payload: { todoItem?: { title?: string; link?: string } }) => {
      const item = payload?.todoItem
      if (!item) return
      notify(item.title ?? '新的待办', undefined, item.link)
    })

    // ── conv:created：被拉入新会话 → 刷新会话列表 ──
    socket.on('conv:created', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] }).catch(() => {})
    })

    // ── presence:sync：在线列表（可选，直接取最新）──
    socket.on('presence:sync', (payload: { onlineUserIds?: string[] }) => {
      if (Array.isArray(payload?.onlineUserIds)) {
        setOnlineUserIds(payload.onlineUserIds)
      }
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
      setConnected(false)
    }
  }, [isAuthenticated, user, addNotification, setConnected, incrementUnread, setUnread, setOnlineUserIds, queryClient])

  return <>{children}</>
}
