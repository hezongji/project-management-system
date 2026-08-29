'use client'

/**
 * 通讯录视图（v1.2 W2，微信式组织架构）
 * 只读：部门树 + 成员列表（头像/姓名/岗位）+ 点成员发起单聊。
 * externals（外部单位）无 userId，仅内部成员可发起单聊。
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { ImAvatar } from '@/components/im/message-bubble'
import { upsertConversation } from '@/components/im/use-im-hooks'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Building2, Search, Users, MessageSquare, CheckSquare, X } from 'lucide-react'

interface DeptMember {
  id: string
  name: string
  email?: string | null
  jobTitle?: string | null
  phone?: string | null
  avatar?: string | null
  role?: string
  isActive?: boolean
}

interface DeptNode {
  id: string
  name: string
  managerName?: string | null
  memberCount?: number
  members?: DeptMember[]
  children?: DeptNode[]
}

export function ContactsView({
  onStartChat,
  onSwitchTab,
}: {
  onStartChat: (conversationId: string) => void
  onSwitchTab: (tab: 'chat') => void
}) {
  const { user } = useAuthStore()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [starting, setStarting] = useState(false)
  // v1.2：多选建群
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [creatingGroup, setCreatingGroup] = useState(false)

  const { data: orgData, isLoading } = useQuery({
    queryKey: ['org-chart'],
    queryFn: async () => {
      const res = await ApiService.get<{ departments?: DeptNode[]; unassigned?: DeptMember[] }>('/org-chart')
      return res.data ?? {}
    },
  })
  const departments = orgData?.departments ?? []
  const unassigned = orgData?.unassigned ?? []

  // 搜索：按成员名过滤部门（部门内含匹配成员则保留并只显示匹配成员）
  const q = query.trim().toLowerCase()
  const filtered = q
    ? departments
        .map((d) => {
          const matchSelf = d.name.toLowerCase().includes(q)
          const matchMembers = (d.members ?? []).filter(
            (m) => m.name.toLowerCase().includes(q) || m.jobTitle?.toLowerCase().includes(q),
          )
          const matchChildren = (d.children ?? []).filter((c) => c.name.toLowerCase().includes(q) || (c.members ?? []).some((m) => m.name.toLowerCase().includes(q)))
          return {
            ...d,
            members: matchSelf ? d.members : matchMembers,
            children: matchSelf ? d.children : matchChildren,
          }
        })
        .filter((d) => (d.members ?? []).length > 0 || (d.children ?? []).length > 0 || d.name.toLowerCase().includes(q))
    : departments

  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }))

  const startChat = async (m: DeptMember) => {
    if (starting || m.id === user?.id) return
    setStarting(true)
    try {
      const res = await ApiService.post<{ id: string }>('/conversations', {
        type: 'SINGLE',
        memberIds: [m.id],
      })
      const id = res.data?.id
      if (id) {
        upsertConversation(queryClient, {
          id,
          type: 'SINGLE',
          name: null,
          projectId: null,
          lastMessageAt: new Date().toISOString(),
          unread: 0,
          myRole: null,
          lastMessage: null,
          members: [{ userId: m.id, name: m.name, email: m.email || '', avatar: m.avatar || null, role: 'MEMBER' }],
        })
        onStartChat(id)
        onSwitchTab('chat')
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '发起单聊失败',
      })
    } finally {
      setStarting(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const createGroup = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || creatingGroup) return
    setCreatingGroup(true)
    try {
      const res = await ApiService.post<{ id: string }>('/conversations', {
        type: 'GROUP',
        memberIds: ids,
      })
      const id = res.data?.id
      if (id) {
        upsertConversation(queryClient, {
          id,
          type: 'GROUP',
          name: null,
          projectId: null,
          lastMessageAt: new Date().toISOString(),
          unread: 0,
          myRole: 'OWNER',
          lastMessage: null,
          members: [],
        })
        onStartChat(id)
        onSwitchTab('chat')
      }
      setSelectMode(false)
      setSelectedIds(new Set())
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '建群失败',
      })
    } finally {
      setCreatingGroup(false)
    }
  }

  const renderDept = (d: DeptNode, depth: number) => {
    // v1.2：默认全部展开；所有有成员或有子部门的部门均可折叠（微信式一致体验）
    const isOpen = expanded[d.id] ?? true
    const members = d.members ?? []
    const hasChildren = (d.children?.length ?? 0) > 0
    const canToggle = hasChildren || members.length > 0
    return (
      <div key={d.id}>
        {/* 部门行 */}
        <button
          type="button"
          onClick={() => canToggle && toggle(d.id)}
          className="flex w-full items-center gap-2 border-b bg-muted/30 px-4 py-2.5 text-left text-sm font-medium"
        >
          {canToggle ? (
            isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
            {d.memberCount ?? members.length} 人
          </span>
        </button>
        {/* 成员列表 */}
        {isOpen &&
          members.map((m) => {
            const checked = selectedIds.has(m.id)
            const isMe = m.id === user?.id
            return (
              <div
                key={m.id}
                onClick={() => (selectMode ? !isMe && toggleSelect(m.id) : !isMe && startChat(m))}
                className={cn('flex items-center gap-3 border-b px-4 py-2.5 active:bg-muted/60', (selectMode || !isMe) && 'cursor-pointer')}
              >
                {selectMode && !isMe && (
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                      checked ? 'border-primary bg-primary text-white' : 'border-muted-foreground/40 bg-white',
                    )}
                  >
                    {checked && '✓'}
                  </span>
                )}
                <ImAvatar name={m.name} avatar={m.avatar} className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {isMe && (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">我</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.jobTitle || m.email || ''}
                  </p>
                </div>
                {!selectMode && !isMe && (
                  <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
                )}
              </div>
            )
          })}
        {/* 子部门 */}
        {isOpen && (d.children ?? []).map((c) => renderDept(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 标题栏 + 搜索（微信式） */}
      <header className="shrink-0 border-b bg-card px-4 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">通讯录</h1>
          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v)
              setSelectedIds(new Set())
            }}
            className={cn('flex items-center gap-1 rounded px-2 py-1 text-sm', selectMode ? 'text-primary' : 'text-muted-foreground')}
          >
            {selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
            {selectMode ? '取消' : '多选'}
          </button>
        </div>
        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索成员或部门"
            className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-3 text-sm outline-none"
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <p className="p-8 text-center text-sm text-muted-foreground">加载中…</p>}
        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
            <Users className="h-8 w-8 opacity-40" />
            <p className="text-sm">未找到成员</p>
          </div>
        )}
        {filtered.map((d) => renderDept(d, 0))}
        {/* v1.2：未分组人员（无部门在职员工） */}
        {!query && unassigned.length > 0 && (
          <div>
            <button type="button" className="flex w-full items-center gap-2 border-b bg-muted/30 px-4 py-2.5 text-left text-sm font-medium">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">未分组</span>
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{unassigned.length} 人</span>
            </button>
            {unassigned.map((m) => {
              const checked = selectedIds.has(m.id)
              const isMe = m.id === user?.id
              return (
                <div
                  key={m.id}
                  onClick={() => (selectMode ? !isMe && toggleSelect(m.id) : !isMe && startChat(m))}
                  className={cn('flex items-center gap-3 border-b px-4 py-2.5 active:bg-muted/60', (selectMode || !isMe) && 'cursor-pointer')}
                >
                  {selectMode && !isMe && (
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                        checked ? 'border-primary bg-primary text-white' : 'border-muted-foreground/40 bg-white',
                      )}
                    >
                      {checked && '✓'}
                    </span>
                  )}
                  <ImAvatar name={m.name} avatar={m.avatar} className="h-10 w-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{m.name}</span>
                      {isMe && (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">我</span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{m.jobTitle || m.email || ''}</p>
                  </div>
                  {!selectMode && !isMe && (
                    <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 多选建群底部操作条（v1.2） */}
      {selectMode && (
        <div className="flex shrink-0 items-center gap-2 border-t bg-card px-4 py-2" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">已选 {selectedIds.size} 人</span>
          <button
            type="button"
            onClick={createGroup}
            disabled={selectedIds.size === 0 || creatingGroup}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {creatingGroup ? '创建中…' : `发起群聊（${selectedIds.size}）`}
          </button>
        </div>
      )}
    </div>
  )
}
