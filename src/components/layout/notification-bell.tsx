'use client'

/**
 * 通知中心（顶栏通知铃）—— 依据《开发文档-项目管理系统重构》§7.9 / §8.3
 *
 * - 铃铛按钮 + 未读数角标（免打扰开启时静默角标）
 * - 点击弹出通知列表（GET /notifications，按 createdAt 倒序）
 * - 未读条目红点；点击条目 → PATCH 标读 + 跳转 link
 * - 「全部已读」按钮 → POST /notifications/read-all
 * - 挂载时拉取未读通知数（角标）+ 待办未完成数（写 notification store，供侧边栏待办角标）
 */

import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  BellRing,
  UserPlus,
  Pencil,
  CheckCircle2,
  Workflow,
  FileSearch,
  FileCheck2,
  AlarmClock,
  AtSign,
  AlertTriangle,
  FileText,
  Info,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ApiService } from '@/services/api'
import { useNotificationStore } from '@/store/notification'
import { isDndEnabled } from '@/lib/dnd'
import { cn } from '@/lib/utils'

interface NotificationItem {
  id: string
  type: string
  title: string
  body?: string | null
  link?: string | null
  isRead: boolean
  createdAt: string
}

interface TodoItemLite {
  id: string
}

const TYPE_META: Record<string, { icon: LucideIcon; className: string; label: string }> = {
  TASK_ASSIGNED: { icon: UserPlus, className: 'text-blue-600 dark:text-blue-400', label: '任务指派' },
  TASK_UPDATED: { icon: Pencil, className: 'text-gray-500 dark:text-gray-400', label: '任务更新' },
  TASK_COMPLETED: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400', label: '任务完成' },
  PHASE_UPDATED: { icon: Workflow, className: 'text-indigo-600 dark:text-indigo-400', label: '阶段更新' },
  FILE_PENDING_REVIEW: { icon: FileSearch, className: 'text-amber-600 dark:text-amber-400', label: '待审核' },
  FILE_APPROVED: { icon: FileCheck2, className: 'text-emerald-600 dark:text-emerald-400', label: '文件通过' },
  FILE_DUE_SOON: { icon: AlarmClock, className: 'text-red-600 dark:text-red-400', label: '到期提醒' },
  MENTION: { icon: AtSign, className: 'text-purple-600 dark:text-purple-400', label: '提到我' },
  ISSUE_NEW: { icon: AlertTriangle, className: 'text-red-600 dark:text-red-400', label: '新问题' },
  ISSUE_RESOLVED: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400', label: '问题关闭' },
  REPORT_NEW: { icon: FileText, className: 'text-blue-600 dark:text-blue-400', label: '新汇报' },
  SYSTEM: { icon: Info, className: 'text-gray-500 dark:text-gray-400', label: '系统通知' },
}

function metaOf(type: string) {
  return (
    TYPE_META[type] ?? {
      icon: Info,
      className: 'text-gray-500 dark:text-gray-400',
      label: '通知',
    }
  )
}

export function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const { notificationUnread, todoUnread, dnd, setNotificationUnread, setTodoUnread, clearNotificationUnread, setDnd } =
    useNotificationStore()

  /** 拉取未读通知数（角标）+ 待办未完成数（侧边栏待办角标） */
  const refreshCounts = useCallback(async () => {
    try {
      const [notifRes, todoRes] = await Promise.all([
        ApiService.get<{ pagination: { total: number } }>(`/notifications?unread=1&limit=1`),
        ApiService.get<TodoItemLite[]>(`/todos?done=0&limit=500`),
      ])
      setNotificationUnread(notifRes.data?.pagination?.total ?? 0)
      setTodoUnread((todoRes.data ?? []).length)
    } catch {
      // 静默失败（未登录/网络异常时保持现状）
    }
  }, [setNotificationUnread, setTodoUnread])

  /** 拉取通知列表 */
  const refreshList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await ApiService.get<{ items: NotificationItem[] }>(`/notifications?page=1&limit=20`)
      setItems(res.data?.items ?? [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setDnd(isDndEnabled()) // 水合免打扰开关（持久化在 localStorage）
    void refreshCounts()
  }, [refreshCounts, setDnd])

  useEffect(() => {
    if (open) void refreshList()
  }, [open, refreshList])

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (buttonRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleItemClick = async (item: NotificationItem) => {
    if (!item.isRead) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)))
      setNotificationUnread(Math.max(0, notificationUnread - 1))
      try {
        await ApiService.patch(`/notifications/${item.id}/read`, {})
      } catch {
        // 标读失败不回滚 UI，下次刷新校正
      }
    }
    if (item.link) {
      setOpen(false)
      // 追加来源标记：目标页显示「已定位 · 来自:通知」（已有 src= 则不覆盖）
      const target = item.link.includes('src=')
        ? item.link
        : `${item.link}${item.link.includes('?') ? '&' : '?'}src=${encodeURIComponent('通知')}`
      // 同源兜底：非站内路径一律回落首页，避免注入外部 URL（参照 lib/notify.ts 写法）
      router.push(target.startsWith('/') ? target : '/')
    }
  }

  const handleReadAll = async () => {
    try {
      await ApiService.post(`/notifications/read-all`, {})
      setItems((prev) => prev.map((n) => ({ ...n, isRead: true })))
      clearNotificationUnread()
    } catch {
      // 静默失败
    }
  }

  /** 删除单条通知（删除工程第5棒）：DELETE /notifications/:id */
  const handleDelete = async (e: ReactMouseEvent, item: NotificationItem) => {
    e.stopPropagation() // 不触发条目点击（标读/跳转）
    const wasUnread = !item.isRead
    setItems((prev) => prev.filter((n) => n.id !== item.id))
    if (wasUnread) setNotificationUnread(Math.max(0, notificationUnread - 1))
    try {
      await ApiService.delete(`/notifications/${item.id}`)
    } catch {
      // 删除失败回滚列表，下次打开面板刷新校正
      void refreshList()
    }
  }

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className="relative"
        title="通知中心"
        onClick={() => setOpen((v) => !v)}
      >
        {notificationUnread > 0 && !dnd ? (
          <BellRing className="h-5 w-5" />
        ) : (
          <Bell className="h-5 w-5" />
        )}
        {notificationUnread > 0 && !dnd && (
          <Badge className="absolute -right-1 -top-1 h-4 min-w-[16px] rounded-full px-1 text-[10px] leading-none">
            {notificationUnread > 99 ? '99+' : notificationUnread}
          </Badge>
        )}
      </Button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">通知中心</p>
            <Button variant="ghost" size="sm" onClick={handleReadAll} disabled={notificationUnread === 0}>
              全部已读
            </Button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">暂无通知</p>
            ) : (
              <ul className="divide-y">
                {items.map((item) => {
                  const meta = metaOf(item.type)
                  const Icon = meta.icon
                  return (
                    <li key={item.id} className="group/item relative">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleItemClick(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') handleItemClick(item)
                        }}
                        className={cn(
                          'flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent',
                          !item.isRead && 'bg-primary/5'
                        )}
                      >
                        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.className)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium">{item.title}</p>
                            {!item.isRead && (
                              <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                            )}
                          </div>
                          {item.body && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
                          )}
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {meta.label} · {new Date(item.createdAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                      </div>
                      {/* 清除单条通知（删除工程第5棒）：hover 显示 */}
                      <button
                        type="button"
                        title="删除该通知"
                        onClick={(e) => handleDelete(e, item)}
                        className="absolute right-2 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus:opacity-100 group-hover/item:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="border-t px-4 py-2 text-center">
            <span className="text-xs text-muted-foreground">
              待办未完成 {todoUnread} 项
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
