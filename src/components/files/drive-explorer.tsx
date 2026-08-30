'use client'

/**
 * 项目网盘资源管理器（20260830-drive-war W3，spec §3.10）
 *
 * 布局：左目录树（USER=普通图标/SYSTEM=盾图标）+ 右列表（面包屑+工具栏+文件夹+文件行+条目行带徽章）
 * 操作：上传（多选）/新建夹/重命名/移动（拖拽到左侧目录 或 弹窗选目录）/删除（软删回收站）/
 *       批量下载/批量删除/回收站（恢复/彻底删/剩余天数）/全局搜索/版本列表
 * 移动端（App WebView）：lg 断点下目录树收起为顶部下拉；操作走按钮（拖拽降级）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, Download, File as FileIcon, FileText, Folder, FolderOpen, FolderPlus,
  HardDrive, History, Home, Loader2, Move, Pencil, Plus, RotateCcw, Search,
  ShieldCheck, Trash2, Upload, X,
} from 'lucide-react'

import { ApiService, ApiError } from '@/services/api'
import { DriveService, FilesService, flattenCatalogs } from '@/services/files'
import { FileService } from '@/services/file'
import { useToast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { STATUS_LABEL } from '@/components/files/badges'
import { FilePreviewDialog } from '@/components/files/file-preview-dialog'
import { globalConfirm } from '@/lib/global-confirm'
import type {
  CatalogNode, CatalogTreeData, DriveListData, DriveRecycleData, DriveSearchData, DriveVersionsData,
} from '@/types/files'
import type { FileVersionDto } from '@/types/phase'

interface DriveExplorerProps {
  projectId: string
  /** 点条目行 → 跳交付计划 Tab（详情抽屉） */
  onOpenRequirement?: (requirementId: string) => void
}

// ───────────────────────────── 工具 ─────────────────────────────

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(t: string): string {
  return t ? new Date(t).toLocaleDateString('zh-CN') : ''
}

function fileIcon(mime: string) {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.startsWith('video/')) return '🎬'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.includes('pdf')) return '📄'
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('compressed')) return '🗜️'
  if (mime.includes('word') || mime.includes('document')) return '📝'
  if (mime.includes('sheet') || mime.includes('excel')) return '📊'
  return '📄'
}

// ───────────────────────────── 主组件 ─────────────────────────────

export function DriveExplorer({ projectId, onOpenRequirement }: DriveExplorerProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [folderId, setFolderId] = useState('') // '' = 根
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // 弹层
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renameTarget, setRenameTarget] = useState<{ kind: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moveTarget, setMoveTarget] = useState<{ fileId: string; name: string } | null>(null)
  const [moveDest, setMoveDest] = useState('')
  const [recycleOpen, setRecycleOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResult, setSearchResult] = useState<DriveSearchData | null>(null)
  const [searching, setSearching] = useState(false)
  const [versionsTarget, setVersionsTarget] = useState<{ id: string; name: string } | null>(null)
  const [versions, setVersions] = useState<DriveVersionsData | null>(null)
  const [previewFile, setPreviewFile] = useState<FileVersionDto | null>(null)
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null)

  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)

  // ── 数据 ──
  const { data: catalogData } = useQuery({
    queryKey: ['catalogs', projectId],
    queryFn: () => FilesService.getCatalogs(projectId),
    enabled: !!projectId,
  })
  const { data: drive, isLoading: listLoading } = useQuery({
    queryKey: ['drive-list', projectId, folderId, page],
    queryFn: () => DriveService.getList({ projectId, folderId: folderId || undefined, page }),
    enabled: !!projectId,
  })

  const catalogs = useMemo(() => catalogData?.items ?? [], [catalogData])
  const flat = useMemo(() => flattenCatalogs(catalogs), [catalogs])

  useEffect(() => {
    setPage(1)
    setSelected(new Set())
  }, [folderId, projectId])

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['drive-list', projectId] })
    void queryClient.invalidateQueries({ queryKey: ['catalogs', projectId] })
  }, [projectId, queryClient])

  // ── 上传 ──
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    if (!folderId) {
      toast({ title: '请先进入一个目录', description: '根级不能直接放文件，请先选中或新建文件夹', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const results = await DriveService.uploadToFolder(folderId, Array.from(files))
      const merged = results.filter((r) => r.file.version > 1).length
      toast({
        description: `已上传 ${results.length} 个文件${merged > 0 ? `（${merged} 个同名合并为新版本）` : ''}`,
      })
      invalidate()
    } catch (e) {
      toast({ title: '上传失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setBusy(false)
      if (uploadInputRef.current) uploadInputRef.current.value = ''
    }
  }

  // ── 新建文件夹 ──
  const handleNewFolder = async () => {
    const name = newFolderName.trim()
    if (!name) return
    setBusy(true)
    try {
      await FilesService.createCatalog(projectId, { name, parentId: folderId || null })
      toast({ description: `文件夹「${name}」已创建` })
      setNewFolderOpen(false)
      setNewFolderName('')
      invalidate()
    } catch (e) {
      toast({ title: '创建失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  // ── 重命名 ──
  const handleRename = async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) return
    setBusy(true)
    try {
      if (renameTarget.kind === 'file') {
        await DriveService.renameFile(renameTarget.id, name)
      } else {
        await FilesService.updateCatalog(projectId, { id: renameTarget.id, name })
      }
      toast({ description: '已重命名' })
      setRenameTarget(null)
      invalidate()
    } catch (e) {
      toast({ title: '重命名失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  // ── 移动（弹窗 or 拖拽） ──
  const doMove = async (fileId: string, destFolderId: string, label: string) => {
    try {
      await FilesService.moveFile(fileId, destFolderId)
      toast({ description: `已移动到「${label}」` })
      invalidate()
    } catch (e) {
      toast({ title: '移动失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    }
  }

  // ── 删除（软删进回收站） ──
  const handleDelete = async (kind: 'file' | 'folder', id: string, name: string) => {
    const yes = await globalConfirm(
      `删除${kind === 'folder' ? '文件夹' : '文件'}「${name}」？将移入回收站，30 天内可恢复（文件夹会连同内部全部内容）。`,
      { confirmText: '移入回收站' },
    )
    if (!yes) return
    try {
      const r = await DriveService.batch(
        kind === 'file' ? { fileIds: [id], action: 'delete' } : { folderIds: [id], action: 'delete' },
      )
      toast({ description: r.deleted > 0 ? `已移入回收站 ${r.deleted} 项` : '操作完成' })
      setSelected(new Set())
      invalidate()
    } catch (e) {
      toast({ title: '删除失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    }
  }

  // ── 批量 ──
  const handleBatchDownload = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await DriveService.batchDownload(Array.from(selected))
      toast({ description: `已开始打包下载 ${selected.size} 个文件` })
    } catch (e) {
      toast({ title: '打包下载失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const handleBatchDelete = async () => {
    if (selected.size === 0) return
    const yes = await globalConfirm(
      `删除选中的 ${selected.size} 个文件？将移入回收站，30 天内可恢复。`,
      { confirmText: '移入回收站' },
    )
    if (!yes) return
    try {
      const r = await DriveService.batch({ fileIds: Array.from(selected), action: 'delete' })
      toast({ description: `已移入回收站 ${r.deleted} 项` })
      setSelected(new Set())
      invalidate()
    } catch (e) {
      toast({ title: '批量删除失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    }
  }

  // ── 全局搜索 ──
  const handleSearch = async () => {
    const q = searchQ.trim()
    if (!q) return
    setSearching(true)
    try {
      setSearchResult(await DriveService.search(q))
    } catch (e) {
      toast({ title: '搜索失败', description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setSearching(false)
    }
  }

  // ── 版本列表 ──
  const openVersions = async (id: string, name: string) => {
    setVersionsTarget({ id, name })
    try {
      setVersions(await DriveService.getVersions(id))
    } catch {
      setVersions(null)
    }
  }

  const perms = drive?.perms
  const crumbs = drive?.folder?.breadcrumb ?? []
  const isSystem = drive?.isSystemFolder ?? false

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── 工具栏 ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 面包屑 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={() => setFolderId('')}>
            <Home className="h-3.5 w-3.5" /> 项目网盘
          </Button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={i === crumbs.length - 1}
                onClick={() => setFolderId(c.id)}
              >
                {c.kind === 'SYSTEM' && <ShieldCheck className="mr-1 h-3.5 w-3.5 text-blue-500" />}
                {c.name}
              </Button>
            </span>
          ))}
          {isSystem && (
            <Badge variant="outline" className="ml-1 shrink-0 border-blue-300 text-blue-600">交付计划区·只读</Badge>
          )}
        </div>

        {/* 移动端：目录下拉（lg 以下显示） */}
        <div className="lg:hidden">
          <Select value={folderId || '__root__'} onValueChange={(v) => setFolderId(v === '__root__' ? '' : v)}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder="切换目录" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="__root__">📍 根目录</SelectItem>
              {flat.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.kind === 'SYSTEM' ? '🛡 ' : '📁 '}
                  {'　'.repeat(Math.max(0, (c.path.match(/\//g)?.length ?? 1) - 1))}
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setNewFolderOpen(true)}
          disabled={!perms?.canUpload}
          title={perms?.canUpload ? '' : '无新建权限'}
        >
          <FolderPlus className="h-4 w-4" /> 新建文件夹
        </Button>
        <Button
          size="sm"
          onClick={() => uploadInputRef.current?.click()}
          disabled={!perms?.canUpload || !folderId || busy}
          title={!folderId ? '请先进入一个目录' : perms?.canUpload ? '' : '无上传权限'}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} 上传
        </Button>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleUpload(e.target.files)}
        />
        <Button size="sm" variant="outline" onClick={() => setSearchOpen(true)}>
          <Search className="h-4 w-4" /> 搜索
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRecycleOpen(true)}>
          <History className="h-4 w-4" /> 回收站
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ── 左：目录树（lg+ 显示）── */}
        <div className="hidden w-60 shrink-0 overflow-y-auto rounded-md border bg-card p-2 lg:block">
          <FolderTreeItem
            node={ROOT_NODE(catalogs)}
            currentId={folderId}
            onSelect={setFolderId}
            dragOverFolder={dragOverFolder}
            setDragOverFolder={setDragOverFolder}
            onDropFile={(fileId, dest) => void doMove(fileId, dest.id, dest.name)}
            defaultOpen
            isRoot
          />
        </div>

        {/* ── 右：列表 ── */}
        <div className="min-w-0 flex-1 overflow-y-auto rounded-md border bg-card">
          {listLoading && !drive ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
            </div>
          ) : (
            <div className="p-3">
              {/* 文件夹区 */}
              {drive && drive.folders.length > 0 && (
                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {drive.folders.map((f) => (
                    <button
                      key={f.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                        dragOverFolder === f.id ? 'border-primary bg-primary/10' : ''
                      }`}
                      onClick={() => setFolderId(f.id)}
                      onDragOver={(e) => { e.preventDefault(); setDragOverFolder(f.id) }}
                      onDragLeave={() => setDragOverFolder(null)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragOverFolder(null)
                        const fileId = e.dataTransfer.getData('text/drive-file')
                        if (fileId) void doMove(fileId, f.id, f.name)
                      }}
                    >
                      {f.kind === 'SYSTEM' ? (
                        <ShieldCheck className="h-4 w-4 shrink-0 text-blue-500" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                      )}
                      <span className="truncate" title={f.name}>{f.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {f.childrenCount > 0 && `${f.childrenCount}夹 `}
                        {f.requirementCount > 0 && `${f.requirementCount}条`}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* 文件/条目列表 */}
              {drive && drive.items.length === 0 && drive.folders.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FolderOpen className="h-8 w-8" />
                  <p className="text-sm">空目录{!isSystem && perms?.canUpload ? '，点击「上传」添加文件或「新建文件夹」' : ''}</p>
                </div>
              ) : (
                drive && drive.items.length > 0 && (
                  <div className="overflow-x-auto">
                    {/* 批量操作条 */}
                    <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                      <span>
                        {selected.size > 0 ? `已选 ${selected.size} 项` : `共 ${drive.pagination.total} 个文件/条目`}
                      </span>
                      {selected.size > 0 && (
                        <>
                          <Button size="sm" variant="outline" className="h-7" onClick={() => void handleBatchDownload()}>
                            <Download className="h-3.5 w-3.5" /> 打包下载
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-destructive" onClick={() => void handleBatchDelete()}>
                            <Trash2 className="h-3.5 w-3.5" /> 批量删除
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>
                            取消选择
                          </Button>
                        </>
                      )}
                    </div>
                    <table className="w-full min-w-[560px] text-sm">
                      <tbody>
                        {drive.items.map((item) => {
                          if (item.type === 'file') {
                            const checked = selected.has(item.id)
                            return (
                              <tr
                                key={item.id}
                                className="border-b transition-colors last:border-0 hover:bg-accent/50"
                                draggable
                                onDragStart={(e) => e.dataTransfer.setData('text/drive-file', item.id)}
                              >
                                <td className="w-8 py-1.5 pl-2">
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => {
                                      const next = new Set(selected)
                                      if (v) next.add(item.id)
                                      else next.delete(item.id)
                                      setSelected(next)
                                    }}
                                  />
                                </td>
                                <td className="max-w-0 py-1.5">
                                  <button
                                    className="flex w-full items-center gap-2 text-left"
                                    onClick={() => setPreviewFile({
                                      id: item.id, name: item.name, originalName: item.name,
                                      size: item.size, mimeType: item.mimeType, version: item.version,
                                      uploadedById: item.uploaderId, uploadedBy: null, createdAt: item.createdAt,
                                    })}
                                    title="预览"
                                  >
                                    <span className="shrink-0">{fileIcon(item.mimeType)}</span>
                                    <span className="truncate">{item.name}</span>
                                    {item.version > 1 && (
                                      <Badge variant="secondary" className="shrink-0">v{item.version}</Badge>
                                    )}
                                  </button>
                                </td>
                                <td className="hidden w-24 shrink-0 py-1.5 text-xs text-muted-foreground sm:table-cell">{fmtSize(item.size)}</td>
                                <td className="hidden w-24 shrink-0 py-1.5 text-xs text-muted-foreground md:table-cell">{item.uploader}</td>
                                <td className="hidden w-24 shrink-0 py-1.5 text-xs text-muted-foreground md:table-cell">{fmtTime(item.createdAt)}</td>
                                <td className="w-40 py-1.5 pr-2">
                                  <div className="flex justify-end gap-0.5">
                                    <IconBtn title="下载" onClick={() => void FileService.download(item.id, item.name)}>
                                      <Download className="h-3.5 w-3.5" />
                                    </IconBtn>
                                    <IconBtn title="版本历史" onClick={() => void openVersions(item.id, item.name)}>
                                      <History className="h-3.5 w-3.5" />
                                    </IconBtn>
                                    {perms?.canEdit && (
                                      <>
                                        <IconBtn
                                          title="重命名"
                                          onClick={() => { setRenameTarget({ kind: 'file', id: item.id, name: item.name }); setRenameValue(item.name) }}
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                        </IconBtn>
                                        <IconBtn
                                          title="移动到…"
                                          onClick={() => { setMoveTarget({ fileId: item.id, name: item.name }); setMoveDest('') }}
                                        >
                                          <Move className="h-3.5 w-3.5" />
                                        </IconBtn>
                                        <IconBtn title="删除" className="text-destructive" onClick={() => void handleDelete('file', item.id, item.name)}>
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </IconBtn>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          }
                          // 条目行（带状态徽章的特殊文件行）
                          return (
                            <tr key={item.id} className="border-b transition-colors last:border-0 hover:bg-accent/50">
                              <td className="w-8 py-1.5 pl-2" />
                              <td className="max-w-0 py-1.5">
                                <button
                                  className="flex w-full items-center gap-2 text-left"
                                  onClick={() => onOpenRequirement?.(item.id)}
                                  title="打开交付条目详情"
                                >
                                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{item.name}</span>
                                  {item.required && <Badge variant="outline" className="shrink-0 border-rose-300 text-rose-500">必需</Badge>}
                                  <Badge
                                    variant={
                                      item.status === 'APPROVED' ? 'default'
                                      : item.status === 'REJECTED' ? 'destructive'
                                      : 'secondary'
                                    }
                                    className="shrink-0"
                                  >
                                    {STATUS_LABEL[item.status as keyof typeof STATUS_LABEL] ?? item.status}
                                  </Badge>
                                  {item.fileCount > 0 && (
                                    <span className="shrink-0 text-xs text-muted-foreground">{item.fileCount}版</span>
                                  )}
                                </button>
                              </td>
                              <td className="hidden w-24 py-1.5 text-xs text-muted-foreground sm:table-cell">—</td>
                              <td className="hidden w-24 truncate py-1.5 text-xs text-muted-foreground md:table-cell">{item.owner}</td>
                              <td className="hidden w-24 py-1.5 text-xs text-muted-foreground md:table-cell">{fmtTime(item.dueDate ?? '')}</td>
                              <td className="w-40 py-1.5 pr-2">
                                <div className="flex justify-end">
                                  <IconBtn title="查看条目" onClick={() => onOpenRequirement?.(item.id)}>
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  </IconBtn>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {/* 分页 */}
                    {drive.pagination.totalPages > 1 && (
                      <div className="mt-2 flex items-center justify-end gap-2 text-sm">
                        <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                        <span className="text-muted-foreground">{page} / {drive.pagination.totalPages}</span>
                        <Button variant="outline" size="sm" className="h-7" disabled={page >= drive.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 新建文件夹弹窗 ── */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>
              {folderId ? `在当前目录下创建` : '在项目根目录创建'}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="文件夹名称"
            onKeyDown={(e) => e.key === 'Enter' && void handleNewFolder()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>取消</Button>
            <Button onClick={() => void handleNewFolder()} disabled={busy || !newFolderName.trim()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 重命名弹窗 ── */}
      <Dialog open={renameTarget !== null} onOpenChange={(v) => !v && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名「{renameTarget?.name}」</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleRename()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button onClick={() => void handleRename()} disabled={busy || !renameValue.trim()}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 移动弹窗 ── */}
      <Dialog open={moveTarget !== null} onOpenChange={(v) => !v && setMoveTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移动「{moveTarget?.name}」到…</DialogTitle>
            <DialogDescription>仅支持项目内移动</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto rounded-md border p-2">
            {flat.filter((c) => c.id !== folderId).map((c) => (
              <button
                key={c.id}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  moveDest === c.id ? 'bg-accent' : ''
                }`}
                onClick={() => setMoveDest(c.id)}
              >
                {c.kind === 'SYSTEM' ? <ShieldCheck className="h-4 w-4 text-blue-500" /> : <Folder className="h-4 w-4 text-amber-500" />}
                <span className="truncate">
                  {'　'.repeat(Math.max(0, (c.path.match(/\//g)?.length ?? 1) - 1))}
                  {c.name}
                </span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveTarget(null)}>取消</Button>
            <Button
              disabled={!moveDest}
              onClick={() => {
                if (!moveTarget || !moveDest) return
                const dest = flat.find((c) => c.id === moveDest)
                setMoveTarget(null)
                if (dest) void doMove(moveTarget.fileId, dest.id, dest.name)
              }}
            >
              移动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 回收站弹层 ── */}
      <RecycleBinDialog
        projectId={projectId}
        open={recycleOpen}
        onOpenChange={setRecycleOpen}
        onChanged={invalidate}
      />

      {/* ── 全局搜索弹层 ── */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>搜索文件（跨项目）</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              autoFocus
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="文件名关键词…"
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
            />
            <Button onClick={() => void handleSearch()} disabled={searching || !searchQ.trim()}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {searchResult && searchResult.items.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的文件</p>
            )}
            {searchResult?.items.map((r) => (
              <div key={r.id} className="flex items-center gap-2 border-b py-2 text-sm last:border-0">
                <span>{fileIcon(r.mimeType)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {r.name}
                    {r.version > 1 && <span className="ml-1 text-xs text-muted-foreground">v{r.version}</span>}
                    {r.isRequirement && <Badge variant="outline" className="ml-1">交付条目</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.projectName} {r.folderPath && `· ${r.folderPath}`} · {fmtSize(r.size)}
                  </p>
                </div>
                <IconBtn title="下载" onClick={() => void FileService.download(r.id, r.name)}>
                  <Download className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 版本历史弹层 ── */}
      <Dialog open={versionsTarget !== null} onOpenChange={(v) => { if (!v) { setVersionsTarget(null); setVersions(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>版本历史「{versionsTarget?.name}」</DialogTitle>
            <DialogDescription>同名上传自动合并为新版本</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {versions?.items.map((v) => (
              <div key={v.id} className="flex items-center gap-2 border-b py-2 text-sm last:border-0">
                <Badge variant={v.id === versions.currentId ? 'default' : 'secondary'}>v{v.version}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {fmtSize(v.size)} · {v.uploadedBy?.name ?? ''} · {fmtTime(v.createdAt)}
                </span>
                <IconBtn title="下载此版本" onClick={() => void FileService.download(v.id, v.originalName || v.name)}>
                  <Download className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            ))}
            {versions && versions.items.length <= 1 && (
              <p className="py-4 text-center text-xs text-muted-foreground">仅一个版本（再次上传同名文件会产生新版本）</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 预览复用 ── */}
      <FilePreviewDialog file={previewFile} open={previewFile !== null} onClose={() => setPreviewFile(null)} />
    </div>
  )
}

// ───────────────────────────── 子组件 ─────────────────────────────

/** 根节点（虚拟：项目网盘），子 = 目录树 roots */
function ROOT_NODE(children: CatalogNode[]): CatalogNode {
  return {
    id: '',
    projectId: '',
    parentId: null,
    name: '项目网盘',
    phaseCode: null,
    order: 0,
    remark: null,
    kind: 'USER',
    path: '',
    requirementCount: 0,
    requirements: [],
    children,
  }
}

function IconBtn({
  title, onClick, className = '', children,
}: {
  title: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${className}`}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      {children}
    </button>
  )
}

/** 目录树节点（递归；支持拖放目标高亮） */
function FolderTreeItem({
  node, currentId, onSelect, dragOverFolder, setDragOverFolder, onDropFile, defaultOpen, isRoot, depth = 0,
}: {
  node: CatalogNode
  currentId: string
  onSelect: (id: string) => void
  dragOverFolder: string | null
  setDragOverFolder: (id: string | null) => void
  onDropFile: (fileId: string, dest: { id: string; name: string }) => void
  defaultOpen?: boolean
  isRoot?: boolean
  depth?: number
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 1)
  const children = node.children ?? []
  const isCurrent = currentId === node.id
  const isDragOver = dragOverFolder === node.id && !isCurrent

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded px-1.5 py-1 text-sm transition-colors ${
          isCurrent ? 'bg-accent font-medium' : 'hover:bg-accent/60'
        } ${isDragOver ? 'ring-2 ring-primary' : ''}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onDragOver={(e) => { if (!isRoot) { e.preventDefault(); setDragOverFolder(node.id) } }}
        onDragLeave={() => setDragOverFolder(null)}
        onDrop={(e) => {
          if (isRoot) return
          e.preventDefault()
          setDragOverFolder(null)
          const fileId = e.dataTransfer.getData('text/drive-file')
          if (fileId && !isCurrent) onDropFile(fileId, { id: node.id, name: node.name })
        }}
      >
        {children.length > 0 ? (
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSelect(isRoot ? '' : node.id)}
        >
          {isRoot ? (
            <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : node.kind === 'SYSTEM' ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-blue-500" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {open && children.map((c) => (
        <FolderTreeItem
          key={c.id}
          node={c}
          currentId={currentId}
          onSelect={onSelect}
          dragOverFolder={dragOverFolder}
          setDragOverFolder={setDragOverFolder}
          onDropFile={onDropFile}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}

/** 回收站弹层 */
function RecycleBinDialog({
  projectId, open, onOpenChange, onChanged,
}: {
  projectId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const { data, refetch } = useQuery({
    queryKey: ['drive-recycle', projectId],
    queryFn: () => DriveService.getRecycle(projectId),
    enabled: open && !!projectId,
  })

  const act = async (input: { fileIds?: string[]; folderIds?: string[]; action: 'restore' | 'purge' }, label: string) => {
    setBusy(true)
    try {
      const r = await DriveService.batch(input)
      toast({
        description:
          input.action === 'restore'
            ? `已恢复 ${r.restored} 项`
            : `已彻底删除 ${r.purged} 项`,
      })
      if (r.errors.length > 0) {
        toast({ title: `${r.errors.length} 项失败`, description: r.errors[0]?.reason, variant: 'destructive' })
      }
      await refetch()
      onChanged()
    } catch (e) {
      toast({ title: label, description: e instanceof Error ? e.message : '请稍后再试', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> 回收站
          </DialogTitle>
          <DialogDescription>保留 30 天，到期自动彻底删除；彻底删除仅项目经理及以上可执行</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto">
          {data && data.folders.length === 0 && data.files.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">回收站是空的</p>
          )}
          {data?.folders.map((f) => (
            <div key={f.id} className="flex items-center gap-2 border-b py-2 text-sm last:border-0">
              <Folder className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">文件夹 · 剩余 {f.daysLeft} 天</p>
              </div>
              <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void act({ folderIds: [f.id], action: 'restore' }, '恢复失败')}>
                <RotateCcw className="h-3.5 w-3.5" /> 恢复
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-destructive" disabled={busy} onClick={() => void act({ folderIds: [f.id], action: 'purge' }, '删除失败')}>
                <Trash2 className="h-3.5 w-3.5" /> 彻底删除
              </Button>
            </div>
          ))}
          {data?.files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 border-b py-2 text-sm last:border-0">
              <span className="shrink-0">{fileIcon(f.mimeType)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {f.name}
                  {f.version > 1 && <span className="ml-1 text-xs text-muted-foreground">v{f.version}</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {f.folderName || '—'} · {fmtSize(f.size)} · 剩余 {f.daysLeft} 天
                </p>
              </div>
              <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void act({ fileIds: [f.id], action: 'restore' }, '恢复失败')}>
                <RotateCcw className="h-3.5 w-3.5" /> 恢复
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-destructive" disabled={busy} onClick={() => void act({ fileIds: [f.id], action: 'purge' }, '删除失败')}>
                <Trash2 className="h-3.5 w-3.5" /> 彻底删除
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 预览桥接说明：直接复用 FilePreviewDialog（行数据 → FileVersionDto 组装见上方 setPreviewFile） */
