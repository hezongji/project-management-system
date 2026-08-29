'use client'

/**
 * chat store（§8.3「新增 chat」）—— 会话未读总数 + 在线列表 + Socket 连接态
 *
 * 设计：
 *   - unreadTotal：全局未读消息总数（**不持久化**，登录后由后端 unread 聚合刷新，
 *     见 SocketProvider connect 事件的离线补拉）
 *   - onlineUserIds：在线用户列表（可选，来自 presence:sync）
 *   - connected：Socket 连接态（im-server :3002）
 *
 * 与 app store 的 unreadCount（站内通知铃）区分：本 store 只管「消息」未读角标。
 */

import { create } from 'zustand'

interface ChatState {
  /** 全局未读消息总数 */
  unreadTotal: number
  /** 在线用户 id 列表（可选） */
  onlineUserIds: string[]
  /** Socket 是否已连接 im-server */
  connected: boolean

  setConnected: (connected: boolean) => void
  setOnlineUserIds: (ids: string[]) => void
  /** 未读 +n（负数会向下取整到 0） */
  incrementUnread: (n: number) => void
  /** 直接设置未读总数（用于离线补拉/后端聚合刷新） */
  setUnread: (n: number) => void
  /** 清零（进入消息页/主动标读后可调用） */
  resetUnread: () => void
}

export const useChatStore = create<ChatState>()((set) => ({
  unreadTotal: 0,
  onlineUserIds: [],
  connected: false,

  setConnected: (connected) => set({ connected }),

  setOnlineUserIds: (onlineUserIds) => set({ onlineUserIds }),

  incrementUnread: (n) =>
    set((s) => ({ unreadTotal: Math.max(0, s.unreadTotal + n) })),

  setUnread: (n) => set({ unreadTotal: Math.max(0, n) }),

  resetUnread: () => set({ unreadTotal: 0 }),
}))
