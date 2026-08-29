'use client'

/**
 * 项目通讯录（v1.2 owner 定案：点项目 = 直接进项目群聊）
 * 项目群 = type PROJECT_GROUP 会话，成员自动=项目成员（后端确保存在）。
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { upsertConversation } from '@/components/im/use-im-hooks'
import { cn } from '@/lib/utils'
import { Search, FolderKanban, ChevronRight } from 'lucide-react'

interface ProjectLite {
  id: string
  name: string
  isArchived: boolean
  myRole?: string
  _count?: { members?: number }
}

export function ProjectsView({
  onStartChat,
  onSwitchTab,
}: {
  onStartChat: (conversationId: string) => void
  onSwitchTab: (tab: 'chat') => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [entering, setEntering] = useState<string | null>(null)

  const { data: projectsData, isLoading } = useQuery({
    queryKey: ['projects-mine-list'],
    queryFn: async () => {
      const res = await ApiService.get<{ items?: ProjectLite[] }>('/projects?limit=100')
      return res.data?.items ?? []
    },
  })
  const projects = (projectsData ?? []).filter((p) => !p.isArchived && p.myRole)
  const q = query.trim().toLowerCase()
  const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects

  const enterProject = async (p: ProjectLite) => {
    if (entering) return
    setEntering(p.id)
    try {
      const res = await ApiService.post<{ conversationId: string }>(`/projects/${p.id}/group`, {})
      const id = res.data?.conversationId
      if (id) {
        upsertConversation(queryClient, {
          id,
          type: 'PROJECT_GROUP',
          name: p.name,
          projectId: p.id,
          lastMessageAt: new Date().toISOString(),
          unread: 0,
          myRole: 'MEMBER',
          lastMessage: null,
          members: [],
        })
        onStartChat(id)
        onSwitchTab('chat')
      }
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '进入项目群失败',
      })
    } finally {
      setEntering(null)
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="shrink-0 border-b bg-card px-4 pb-2 pt-3">
        <h1 className="text-lg font-semibold">项目</h1>
        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目"
            className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-3 text-sm outline-none"
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <p className="p-8 text-center text-sm text-muted-foreground">加载中…</p>}
        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
            <FolderKanban className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无项目</p>
          </div>
        )}
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => enterProject(p)}
            disabled={entering !== null}
            className="flex w-full items-center gap-3 border-b px-4 py-3 text-left active:bg-muted/60"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FolderKanban className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">
                {p._count?.members != null ? `${p._count.members} 名成员` : '项目群'}
                {entering === p.id ? ' · 进入中…' : ''}
              </span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  )
}
