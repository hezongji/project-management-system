'use client'

/**
 * notification store（§7.9 / §8.3）—— 顶栏通知铃未读数 + 侧边栏待办角标 + 免打扰
 *
 * 与 chat store（消息未读）区分：本 store 只管「站内通知」未读 + 「待办」未完成数 + 免打扰开关。
 * 不持久化（免打扰的持久化在 lib/dnd.ts 的 localStorage），登录后由通知铃组件拉取刷新。
 */

import { create } from 'zustand'

interface NotificationState {
  /** 站内通知未读数（顶栏通知铃角标） */
  notificationUnread: number
  /** 待办收件箱未完成数（侧边栏角标） */
  todoUnread: number
  /** 免打扰（true 时静默角标；持久化在 localStorage pm-dnd） */
  dnd: boolean

  setNotificationUnread: (n: number) => void
  setTodoUnread: (n: number) => void
  clearNotificationUnread: () => void
  setDnd: (enabled: boolean) => void
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  notificationUnread: 0,
  todoUnread: 0,
  dnd: false,

  setNotificationUnread: (n) => set({ notificationUnread: Math.max(0, n) }),
  setTodoUnread: (n) => set({ todoUnread: Math.max(0, n) }),
  clearNotificationUnread: () => set({ notificationUnread: 0 }),
  setDnd: (enabled) => set({ dnd: enabled }),
}))
