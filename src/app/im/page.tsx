'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageGuard } from '@/components/layout/page-guard'
import { useAuthStore } from '@/store/auth'
import { useConversations } from '@/components/im/use-im-hooks'
import { ConversationList } from '@/components/im-mobile/conversation-list'
import { ChatView } from '@/components/im-mobile/chat-view'
import { ContactsView } from '@/components/im-mobile/contacts-view'
import { ProjectsView } from '@/components/im-mobile/projects-view'
import { MeView } from '@/components/im-mobile/me-view'
import { type ConversationItem } from '@/components/im/use-im-hooks'
import { cn } from '@/lib/utils'
import { MessageSquare, BookUser, FolderKanban, UserRound } from 'lucide-react'

/**
 * /im —— PM 聊天 App 主壳（v1.2 W2，微信式三 Tab：聊天/通讯录/我的）
 * 权限沿用 pageKey="messages"（与 PM 权限一致）。
 */
export default function ImPage() {
  return (
    <PageGuard pageKey="messages">
      <ImAppShell />
    </PageGuard>
  )
}

type TabKey = 'chat' | 'projects' | 'contacts' | 'me'

const TABS: Array<{ key: TabKey; label: string; icon: typeof MessageSquare }> = [
  { key: 'chat', label: '聊天', icon: MessageSquare },
  { key: 'projects', label: '项目', icon: FolderKanban },
  { key: 'contacts', label: '通讯录', icon: BookUser },
  { key: 'me', label: '我的', icon: UserRound },
]

function ImAppShell() {
  const { conversations, convsLoading } = useConversations()
  const [tab, setTab] = useState<TabKey>('chat')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 会话被解散/删除时回列表
  useEffect(() => {
    if (selectedId && !convsLoading && conversations.length > 0 && !conversations.some((c) => c.id === selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, conversations, convsLoading])

  const current: ConversationItem | null =
    conversations.find((c) => c.id === selectedId) ?? null

  // v1.6：返回键一级一级返回（通知壳层是否还有上一级 + 监听 pm-back 事件）
  const canBack = tab !== 'chat' || current != null
  useEffect(() => {
    const bridge = (window as unknown as { AndroidBridge?: { setBackEnabled?: (b: boolean) => void } }).AndroidBridge
    bridge?.setBackEnabled?.(canBack)
  }, [canBack])

  useEffect(() => {
    const onBack = () => {
      if (current) setSelectedId(null)        // 聊天视图 → 会话列表
      else if (tab !== 'chat') setTab('chat') // 其他 Tab → 聊天
    }
    window.addEventListener('pm-back', onBack)
    return () => window.removeEventListener('pm-back', onBack)
  }, [current, tab])

  // 聊天 Tab 未读总角标（排除 muted——微信行为）
  const unreadTotal = useMemo(
    () => conversations.reduce((acc, c) => acc + (c.myPrefs?.muted ? 0 : c.unread), 0),
    [conversations],
  )

  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* 主内容区（三 Tab 共享） */}
      <div className="min-h-0 flex-1">
        {tab === 'chat' &&
          (current ? (
            <ChatView
              key={current.id}
              conversation={current}
              onBack={() => setSelectedId(null)}
              onConversationChanged={() => {}}
            />
          ) : (
            <ConversationList
              conversations={conversations}
              loading={convsLoading}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
        {tab === 'contacts' && <ContactsView onStartChat={setSelectedId} onSwitchTab={setTab} />}
        {tab === 'projects' && <ProjectsView onStartChat={setSelectedId} onSwitchTab={setTab} />}
        {tab === 'me' && <MeView />}
      </div>

      {/* 底部 Tab 栏（微信式） */}
      <nav
        className="flex shrink-0 border-t bg-card"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {TABS.map((t) => {
          const active = tab === t.key
          const Icon = t.icon
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                // v1.2：聊天视图内再点「聊天」Tab → 回会话列表（替代顶部返回箭头）
                if (t.key === 'chat' && tab === 'chat' && current) {
                  setSelectedId(null)
                } else {
                  setTab(t.key)
                }
              }}
              className={cn(
                'relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px]',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <span className="relative">
                <Icon className={cn('h-6 w-6', active && 'fill-primary/10')} />
                {t.key === 'chat' && unreadTotal > 0 && (
                  <span className="absolute -right-2.5 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
                    {unreadTotal > 99 ? '99+' : unreadTotal}
                  </span>
                )}
              </span>
              <span>{t.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
