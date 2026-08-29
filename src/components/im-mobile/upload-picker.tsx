'use client'

/**
 * 上传项目/目录选择器（v1.1 W3，2026-08-29）
 *
 * 单弹层：上半部项目列表（我参与的，OWNER/ADMIN 放行其余置灰，归档隐藏，会话项目预选）
 *         下半部选中项目的目录树（记住上次目录）
 * 确认回调 (project, catalog)：附件强制关联项目，落库自动按项目归档。
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { ApiService } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { FolderOpen, Search, Lock } from 'lucide-react'

interface ProjectLite {
  id: string
  name: string
  myRole: string
  isArchived: boolean
}

interface CatalogNode {
  id: string
  name: string
  children?: CatalogNode[]
}

export interface UploadTarget {
  projectId: string
  projectName: string
  catalogId: string
  catalogName: string
}

const PREFS_KEY = 'im-upload-pref' // { [projectId]: catalogId }

function readPrefs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
  } catch {
    return {}
  }
}
function savePrefs(projectId: string, catalogId: string) {
  const prefs = readPrefs()
  prefs[projectId] = catalogId
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export function UploadPicker({
  open,
  fileName,
  defaultProjectId,
  onClose,
  onConfirm,
  uploading,
}: {
  open: boolean
  fileName?: string
  /** 会话关联项目：预选 */
  defaultProjectId?: string | null
  onClose: () => void
  onConfirm: (target: UploadTarget) => void
  uploading?: boolean
}) {
  const { user } = useAuthStore()
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? '')
  const [catalogId, setCatalogId] = useState<string>('')

  // 我参与的项目（limit=100 防漏项）
  const { data: projectsData } = useQuery({
    queryKey: ['projects-mine'],
    queryFn: async () => {
      const res = await ApiService.get<{ items?: ProjectLite[] }>('/projects?limit=100')
      return res.data?.items ?? []
    },
    enabled: open,
  })
  const projects = useMemo(
    () => (projectsData ?? []).filter((p) => !p.isArchived),
    [projectsData],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const isSystemAdmin = user?.role === 'ADMIN'
  const canUpload = (p: ProjectLite) =>
    isSystemAdmin || p.myRole === 'OWNER' || p.myRole === 'ADMIN'

  // 选中项目的目录树
  const { data: catalogsData } = useQuery({
    queryKey: ['project-catalogs', projectId],
    queryFn: async () => {
      const res = await ApiService.get<{ items?: CatalogNode[] }>(`/projects/${projectId}/catalogs`)
      return res.data?.items ?? []
    },
    enabled: open && !!projectId,
  })
  const flatCatalogs = useMemo(() => {
    const flat: { id: string; name: string; depth: number }[] = []
    const walk = (nodes: CatalogNode[] | undefined, depth: number) => {
      nodes?.forEach((n) => {
        flat.push({ id: n.id, name: n.name, depth })
        walk(n.children, depth + 1)
      })
    }
    walk(catalogsData, 0)
    return flat
  }, [catalogsData])

  // 预选：会话项目 → 记住的上次目录 → 第一个
  useEffect(() => {
    if (!open) return
    setProjectId((prev) => {
      const target = prev && projects.some((p) => p.id === prev)
        ? prev
        : defaultProjectId && projects.some((p) => p.id === defaultProjectId)
          ? defaultProjectId
          : ''
      return target
    })
  }, [open, projects, defaultProjectId])

  useEffect(() => {
    if (!projectId || flatCatalogs.length === 0) {
      setCatalogId('')
      return
    }
    const last = readPrefs()[projectId]
    if (last && flatCatalogs.some((c) => c.id === last)) {
      setCatalogId(last)
    } else {
      setCatalogId(flatCatalogs[0].id)
    }
  }, [projectId, flatCatalogs])

  const selectedProject = projects.find((p) => p.id === projectId) ?? null
  const selectedCatalog = flatCatalogs.find((c) => c.id === catalogId) ?? null

  const confirm = () => {
    if (!selectedProject || !selectedCatalog) return
    savePrefs(selectedProject.id, selectedCatalog.id)
    onConfirm({
      projectId: selectedProject.id,
      projectName: selectedProject.name,
      catalogId: selectedCatalog.id,
      catalogName: selectedCatalog.name,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80dvh] max-w-sm flex-col">
        <DialogHeader>
          <DialogTitle>选择归档项目与目录</DialogTitle>
          <DialogDescription className="break-all">
            {fileName ? `上传「${fileName}」到：` : '选择上传目标：'}
          </DialogDescription>
        </DialogHeader>

        {/* 项目搜索 */}
        <div className="relative shrink-0">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目…"
            className="pl-8"
          />
        </div>

        {/* 项目列表 */}
        <div className="max-h-44 shrink-0 space-y-0.5 overflow-y-auto rounded-md border p-1">
          {filtered.length === 0 && (
            <p className="p-2 text-center text-xs text-muted-foreground">无项目</p>
          )}
          {filtered.map((p) => {
            const okUpload = canUpload(p)
            return (
              <button
                key={p.id}
                type="button"
                disabled={!okUpload}
                onClick={() => setProjectId(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                  projectId === p.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                  !okUpload && 'opacity-45',
                )}
              >
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {!okUpload && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground" title="你的角色无上传权限">
                    <Lock className="h-3 w-3" />
                    无上传权限
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* 目录树（扁平带缩进） */}
        <div className="max-h-44 flex-1 overflow-y-auto rounded-md border p-1">
          {!projectId && (
            <p className="p-2 text-center text-xs text-muted-foreground">先选择项目</p>
          )}
          {projectId && flatCatalogs.length === 0 && (
            <p className="p-2 text-center text-xs text-muted-foreground">该项目暂无文件目录</p>
          )}
          {flatCatalogs.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCatalogId(c.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                catalogId === c.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
              )}
              style={{ paddingLeft: 8 + c.depth * 14 }}
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {selectedProject && selectedCatalog
              ? `将归档到：${selectedProject.name} / ${selectedCatalog.name}`
              : '请选择项目与目录'}
          </p>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={confirm} disabled={!selectedProject || !selectedCatalog || uploading}>
            {uploading ? '上传中…' : '上传并发送'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
