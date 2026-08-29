'use client'

/**
 * 移动端会话列表（微信式 v1.2 W3 增强）
 * 置顶分组 / 免打扰灰点 / 长按菜单（置顶·免打扰·删除）/ 搜索 / 下拉刷新 / 隐藏会话新消息自动复活
 */

import { useMemo, useRef, useState } from 'react'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { cn, formatRelativeTime } from '@/lib/utils'
import { ImAvatar } from '@/components/im/message-bubble'
import { previewText } from '@/components/im/utils'
import { MemberPicker, type PickerMember } from '@/components/im/member-picker'
import { useConversations, type ConversationItem } from '@/components/im/use-im-hooks'
import { useLongPress } from './long-press'
import { MessageSquare, Plus, Search, Pin, PinOff, BellOff, Bell, Trash2 } from 'lucide-react'

export function ConversationList({
  conversations,
  loading,
  selectedId,
  onSelect,
}: {
  conversations: ConversationItem[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const { user } = useAuthStore()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { refetch } = useConversations()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [menuConv, setMenuConv] = useState<{ conv: ConversationItem; x: number; y: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const pullStart = useRef<number | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['conversations'] })

  const handleCreate = async (selected: PickerMember[]) => {
    const ids = selected.map((s) => s.id)
    if (ids.length === 0) return
    setCreating(true)
    try {
      const type = ids.length <= 1 ? 'SINGLE' : 'GROUP'
      const res = await ApiService.post<{ id: string }>('/conversations', {
        type,
        memberIds: ids,
      })
      const id = res.data?.id
      invalidate()
      if (id) onSelect(id)
      toast({ description: type === 'SINGLE' ? '单聊已打开' : '群聊已创建' })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '发起聊天失败',
      })
    } finally {
      setCreating(false)
    }
  }

  const setPref = async (conv: ConversationItem, patch: { isPinned?: boolean; muted?: boolean; hiddenAt?: string | null }) => {
    try {
      await ApiService.patch(`/conversations/${conv.id}/prefs`, patch)
      invalidate()
    } catch {
      toast({ variant: 'destructive', description: '操作失败，请稍后再试' })
    }
  }

  const title = (c: ConversationItem) =>
    c.name || c.members.map((m) => m.name).filter(Boolean).join('、') || '会话'
  const firstOther = (c: ConversationItem) =>
    c.members.find((m) => m.userId !== user?.id) ?? c.members[0]

  // 隐藏过滤（hiddenAt < lastMessageAt = 新消息自动复活）+ 搜索过滤 + 置顶分组排序
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations
      .filter((c) => {
        const hid = c.myPrefs?.hiddenAt
        if (hid && new Date(hid) >= new Date(c.lastMessageAt)) return false
        if (!q) return true
        return title(c).toLowerCase().includes(q) || c.members.some((m) => m.name.toLowerCase().includes(q))
      })
      .sort((a, b) => {
        const pa = a.myPrefs?.isPinned ? 1 : 0
        const pb = b.myPrefs?.isPinned ? 1 : 0
        if (pa !== pb) return pb - pa
        return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      })
  }, [conversations, query])

  const longPress = useLongPress((x, y) => {
    const el = document.elementFromPoint(x, y)
    const row = el?.closest?.('[data-cid]') as HTMLElement | null
    const cid = row?.dataset.cid
    if (!cid) return
    const conv = conversations.find((c) => c.id === cid)
    if (!conv) return
    setMenuConv({ conv, x, y })
  })

  const menuRect = menuConv
    ? { left: Math.min(menuConv.x, window.innerWidth - 200), top: Math.min(menuConv.y, window.innerHeight - 240) }
    : null

  // 下拉刷新
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.target instanceof Element && e.target.closest('.conv-scroll') && e.target.closest('.conv-scroll')!.scrollTop === 0) {
      pullStart.current = e.touches[0].clientY
    } else {
      pullStart.current = null
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (pullStart.current == null) return
    const dy = e.touches[0].clientY - pullStart.current
    if (dy > 60 && !refreshing) setRefreshing(true)
  }
  const onTouchEnd = async () => {
    if (refreshing) {
      await refetch()
      await new Promise((r) => setTimeout(r, 300))
      setRefreshing(false)
    }
    pullStart.current = null
  }

  let lastPinned = false

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 标题栏 + 搜索（微信式） */}
      <header className="shrink-0 border-b bg-card px-4 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">PM 聊天</h1>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            title="发起聊天"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话或成员"
            className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-3 text-sm outline-none"
          />
        </div>
      </header>

      {/* 会话列表 */}
      <div
        className="conv-scroll min-h-0 flex-1 overflow-y-auto"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {refreshing && (
          <p className="py-2 text-center text-[11px] text-muted-foreground">刷新中…</p>
        )}
        {loading && <p className="p-8 text-center text-sm text-muted-foreground">加载中…</p>}
        {!loading && visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
            <MessageSquare className="h-8 w-8 opacity-40" />
            <p className="text-sm">{query ? '未找到会话' : '暂无会话，点右上角 + 发起聊天'}</p>
          </div>
        )}
        {visible.map((c) => {
          const other = firstOther(c)
          const preview = c.lastMessage
            ? `${c.lastMessage.senderName ?? ''}：${previewText(c.lastMessage.type, c.lastMessage.content)}`
            : '暂无消息'
          const pinned = !!c.myPrefs?.isPinned
          const muted = !!c.myPrefs?.muted
          const showDivider = pinned !== lastPinned
          lastPinned = pinned
          return (
            <div key={c.id}>
              {/* 置顶分组分隔条 */}
              {showDivider && (
                <div className="flex items-center gap-2 bg-muted/50 px-4 py-1 text-[10px] text-muted-foreground">
                  {pinned && <Pin className="h-3 w-3" />}
                  {pinned ? '置顶聊天' : '聊天'}
                </div>
              )}
              <button
                type="button"
                data-cid={c.id}
                {...longPress}
                onClick={() => onSelect(c.id)}
                className={cn(
                  'flex w-full items-center gap-3 border-b px-4 py-3 text-left active:bg-muted/60',
                  selectedId === c.id && 'bg-muted/40',
                  pinned && 'bg-muted/20',
                )}
              >
                <ImAvatar
                  name={title(c)}
                  avatar={c.name ? null : other?.avatar}
                  className="h-11 w-11"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[15px] font-medium">{title(c)}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {muted && <BellOff className="h-3 w-3 text-muted-foreground/60" />}
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(c.lastMessageAt)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] text-muted-foreground">{preview}</p>
                    {c.unread > 0 && (
                      muted ? (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50" />
                      ) : (
                        <Badge className="h-4.5 min-w-[18px] shrink-0 rounded-full bg-red-500 px-1.5 text-[10px] leading-none text-white">
                          {c.unread > 99 ? '99+' : c.unread}
                        </Badge>
                      )
                    )}
                  </div>
                </div>
              </button>
            </div>
          )
        })}
      </div>

      {/* 长按操作菜单（置顶/免打扰/删除） */}
      {menuConv && menuRect && (
        <div className="fixed inset-0 z-50" onClick={() => setMenuConv(null)}>
          <div
            className="absolute flex flex-col rounded-xl border bg-card py-1 shadow-xl"
            style={{ left: menuRect.left, top: menuRect.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setPref(menuConv.conv, { isPinned: !menuConv.conv.myPrefs?.isPinned })
                setMenuConv(null)
              }}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
            >
              {menuConv.conv.myPrefs?.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              {menuConv.conv.myPrefs?.isPinned ? '取消置顶' : '置顶聊天'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPref(menuConv.conv, { muted: !menuConv.conv.myPrefs?.muted })
                setMenuConv(null)
              }}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted"
            >
              {menuConv.conv.myPrefs?.muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
              {menuConv.conv.myPrefs?.muted ? '开启提醒' : '消息免打扰'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPref(menuConv.conv, { hiddenAt: new Date().toISOString() })
                toast({ description: '已删除会话（有新消息时自动恢复）' })
                setMenuConv(null)
              }}
              className="flex items-center gap-2 px-4 py-2.5 text-left text-sm text-destructive hover:bg-muted"
            >
              <Trash2 className="h-4 w-4" />
              删除会话
            </button>
          </div>
        </div>
      )}

      <MemberPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="multi"
        title="发起聊天"
        description="勾选一位成员发起单聊，勾选多位成员创建群聊"
        confirmText={(n) => (n <= 1 ? '发起单聊' : `发起群聊（${n} 人）`)}
        excludeIds={user?.id ? [user.id] : []}
        loading={creating}
        onConfirm={handleCreate}
      />
    </div>
  )
}
