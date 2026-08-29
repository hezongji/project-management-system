'use client'

/**
 * 移动端群成员抽屉（微信式，W2 2026-08-29）
 * 右侧滑入面板：会话名 + 成员数 + 成员列表（头像照片/首字母 + 姓名 + 角色徽标 + 群主标记）
 */

import { X, Crown, Shield, Megaphone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ImAvatar } from '@/components/im/message-bubble'
import { type ConversationItem } from '@/components/im/use-im-hooks'

const ROLE_LABEL: Record<string, string> = {
  OWNER: '群主',
  ADMIN: '管理员',
  MEMBER: '成员',
  VIEWER: '成员',
}

export function MemberDrawer({
  open,
  conversation,
  meId,
  onClose,
  canManage = false,
  onEditAnnouncement,
}: {
  open: boolean
  conversation: ConversationItem | null
  meId?: string
  onClose: () => void
  canManage?: boolean
  onEditAnnouncement?: () => void
}) {
  if (!open || !conversation) return null
  const isGroup = conversation.type === 'GROUP'
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40" />
      {/* 面板（右侧滑入） */}
      <div
        className="absolute inset-y-0 right-0 flex w-[85%] max-w-xs flex-col bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b px-4 pb-3 pt-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {conversation.name || '会话'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isGroup ? '群聊' : '单聊'} · {conversation.members.length} 人
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            title="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto py-2">
          {canManage && (
            <button
              type="button"
              onClick={onEditAnnouncement}
              className="mx-3 my-1 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-left text-sm font-medium text-amber-600"
            >
              <Megaphone className="h-4 w-4" />
              {conversation.announcement ? '编辑群公告' : '发布群公告'}
            </button>
          )}
          {conversation.members.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 px-4 py-2.5">
              <ImAvatar name={m.name} avatar={m.avatar} className="h-10 w-10" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  {m.userId === meId && (
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      我
                    </span>
                  )}
                </div>
                {m.email && <p className="truncate text-xs text-muted-foreground">{m.email}</p>}
              </div>
              {m.role === 'OWNER' && (
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">
                  <Crown className="h-3 w-3" />
                  群主
                </span>
              )}
              {m.role === 'ADMIN' && (
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                  <Shield className="h-3 w-3" />
                  管理员
                </span>
              )}
              {isGroup && m.role !== 'OWNER' && m.role !== 'ADMIN' && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {ROLE_LABEL[m.role] || '成员'}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
