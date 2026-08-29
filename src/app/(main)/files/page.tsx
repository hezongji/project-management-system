'use client'

import { PageGuard } from '@/components/layout/page-guard'
/**
 * /files 文件目录管理页 —— 依据《开发文档-项目管理系统重构》§8.2④
 *
 * 布局：顶部项目选择器；左 CatalogTree（右键增删改）+ 右 RequirementTable
 *       （TanStack Table：名称/编号/责任人/用途/范围/状态/截止/操作列；
 *        筛选器：状态/我负责/超期；工具栏：新建/导入/导出/归档矩阵）。
 * 行点开 → 条目详情抽屉（版本时间线 + 预览/审核骨架，P2-2/P2-3 接续）。
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  Download,
  FileText,
  FolderInput,
  FolderOpen,
  Grid3X3,
  Loader2,
  Plus,
  Upload,
  User,
} from 'lucide-react'

import { ApiService, ApiError } from '@/services/api'
import { OrgService } from '@/services/org'
import { FilesService, flattenCatalogs } from '@/services/files'
import { useFocusHighlight } from '@/hooks/use-focus-highlight'
import { useToast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TablePagination } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { CatalogTree } from '@/components/files/catalog-tree'
import { CatalogDialog, type CatalogFormValue } from '@/components/files/catalog-dialog'
import { RequirementFormDialog } from '@/components/files/requirement-form-dialog'
import { RequirementTable } from '@/components/files/requirement-table'
import { RequirementDetailDrawer } from '@/components/files/requirement-detail-drawer'
import { AiExplainDialog } from '@/components/ai/ai-explain-dialog'
import { ImportDialog } from '@/components/files/import-dialog'
import { FileMatrixDialog } from '@/components/files/file-matrix-dialog'
import { ALL_STATUSES, STATUS_LABEL, SCOPE_LABEL } from '@/components/files/badges'
import { exportRequirements } from '@/lib/excel-templates'

import { globalConfirm } from '@/lib/global-confirm'
import type {
  CatalogNode,
  FileRequirementItem,
  RequirementInput,
} from '@/types/files'

interface ProjectOption {
  id: string
  code: string
  name: string
}

function FilesPageInner() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  // ★ 删除工程第 4 棒：当前用户（条目删除权限近似显示，服务端终审）
  const { data: me } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () =>
      ApiService.get<{ id: string; role: string }>('/auth/me').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })

  // ── 项目选择 ──
  const [projectId, setProjectId] = useState('')

  const { data: projects = [] } = useQuery({
    queryKey: ['files-projects'],
    queryFn: () =>
      ApiService.get<{ items: ProjectOption[] }>('/projects?limit=100').then(
        (r) => r.data?.items ?? [],
      ),
  })

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('projectId')
    if (p) {
      setProjectId(p)
      return
    }
    if (!projectId && projects.length > 0) setProjectId(projects[0].id)
  }, [projects, projectId])

  // ── 筛选状态 ──
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [page, setPage] = useState(1)

  // ── 数据 ──
  const { data: catalogData } = useQuery({
    queryKey: ['catalogs', projectId],
    queryFn: () => FilesService.getCatalogs(projectId),
    enabled: !!projectId,
  })
  const { data: members = [] } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => FilesService.getProjectMembers(projectId),
    enabled: !!projectId,
  })
  const { data: orgs = [] } = useQuery({
    queryKey: ['external-orgs-flat'],
    queryFn: () =>
      OrgService.getExternalOrgs({ limit: 100 }).then((r) =>
        r.items.map((o) => ({ id: o.id, name: o.name })),
      ),
  })

  const { data: reqData, isLoading: reqLoading } = useQuery({
    queryKey: ['file-requirements', projectId, selectedCatalogId, statusFilter, mineOnly, overdueOnly, page],
    queryFn: () =>
      FilesService.getRequirements({
        projectId,
        catalogId: selectedCatalogId ?? undefined,
        status: statusFilter || undefined,
        mine: mineOnly,
        overdue: overdueOnly,
        page,
        limit: 20,
      }),
    enabled: !!projectId,
  })

  const catalogs = catalogData?.items ?? []
  const canEdit = catalogData?.can.edit ?? false
  const canCreate = reqData?.can.create ?? false
  const items = reqData?.items ?? []
  const pagination = reqData?.pagination
  const flatCatalogs = useMemo(() => flattenCatalogs(catalogs), [catalogs])

  // ── 计划外文件（临时文件，W4：PC 端文件移动）──
  const { data: adhocData, isLoading: adhocLoading, refetch: refetchAdhoc } = useQuery({
    queryKey: ['adhoc-files', projectId, selectedCatalogId],
    queryFn: () => FilesService.getAdhocFiles(projectId, selectedCatalogId!),
    enabled: !!projectId && !!selectedCatalogId,
  })
  const adhocFiles = adhocData?.items ?? []
  // 移动弹窗：目标目录选择
  const [moveDialog, setMoveDialog] = useState<{ open: boolean; fileId: string; fileName: string; targetCatalogId: string }>({
    open: false,
    fileId: '',
    fileName: '',
    targetCatalogId: '',
  })
  const [moving, setMoving] = useState(false)

  const handleMove = async () => {
    if (!moveDialog.targetCatalogId || moving) return
    setMoving(true)
    try {
      await FilesService.moveFile(moveDialog.fileId, moveDialog.targetCatalogId)
      toast({ description: '文件已移动' })
      setMoveDialog((s) => ({ ...s, open: false }))
      void refetchAdhoc()
    } catch (e) {
      toast({
        title: '移动失败',
        description: e instanceof Error ? e.message : '请稍后再试',
        variant: 'destructive',
      })
    } finally {
      setMoving(false)
    }
  }

  useEffect(() => {
    setPage(1)
  }, [selectedCatalogId, statusFilter, mineOnly, overdueOnly, projectId])

  // ── 弹窗状态 ──
  const [catalogDialog, setCatalogDialog] = useState<{
    open: boolean
    parent: CatalogNode | null
    node: CatalogNode | null
  }>({ open: false, parent: null, node: null })
  const [savingCatalog, setSavingCatalog] = useState(false)

  const [reqDialog, setReqDialog] = useState<{
    open: boolean
    item: FileRequirementItem | null
  }>({ open: false, item: null })
  const [savingReq, setSavingReq] = useState(false)

  const [importOpen, setImportOpen] = useState(false)
  const [matrixOpen, setMatrixOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<FileRequirementItem | null>(null)
  // 持久选中行：点击行 / 跳转定位命中后高亮，点击其他行自动切换（2026-08-25 修复：高亮不随选中切换）
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  // ★ AI 解读（S4）：条目行「解读」按钮 → 弹窗调 /api/ai/explain-file
  const [explainItem, setExplainItem] = useState<FileRequirementItem | null>(null)

  // ── 跨页定位（useFocusHighlight 约定）：?requirementId=xx → 清筛选 → 分块查到所在页 → 行高亮闪烁 ──
  const { focusId: focusReqId, srcLabel, clearFocus } = useFocusHighlight(['requirementId'])
  const locatedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId || !focusReqId || locatedRef.current === focusReqId) return
    locatedRef.current = focusReqId
    let cancelled = false
    ;(async () => {
      // 目标行必须可达：清掉目录/状态/我负责/超期四项筛选（不清则行永远不在列表里）
      setSelectedCatalogId(null)
      setStatusFilter('')
      setMineOnly(false)
      setOverdueOnly(false)
      try {
        // 分块查找：每批 100 条 = 5 展示页，最多 4 批 = 20 页；一次定位无需逐页翻
        for (let chunk = 1; chunk <= 4; chunk++) {
          const data = await FilesService.getRequirements({ projectId, page: chunk, limit: 100 })
          if (cancelled) return
          const idx = data.items.findIndex((it) => it.id === focusReqId)
          if (idx >= 0) {
            setPage((chunk - 1) * 5 + Math.floor(idx / 20) + 1)
            // 自动选中目标行（持久高亮，后续点击其他行可切换）
            setSelectedRowId(focusReqId)
            // 闪烁动画（3.4s）结束后清掉 URL 定位参数，避免刷新重复定位 / 数据重拉重复闪烁
            setTimeout(() => clearFocus(), 3600)
            return
          }
          if (data.items.length < 100) break
        }
        if (!cancelled) {
          toast({ title: '未在前20页找到该条目，可能已被删除' })
          clearFocus()
        }
      } catch {
        /* 定位失败不阻塞正常浏览 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, focusReqId, toast])

  // 个人交付物跳转（2026-08-21）：?requirementId=xx → 自动打开详情抽屉（含上传）
  useEffect(() => {
    if (!projectId) return
    const rid = new URLSearchParams(window.location.search).get('requirementId')
    if (!rid || detailItem) return
    FilesService.getRequirement(projectId, rid)
      .then((item) => {
        if (item) setDetailItem(item)
      })
      .catch(() => {
        /* 条目不存在则静默 */
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, detailItem])

  // 关闭抽屉：同时清除 URL 的 requirementId，防止 effect 重新打开（2026-08-21 修复）
  const closeDetail = () => {
    setDetailItem(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('requirementId')
    window.history.replaceState(null, '', url.toString())
  }

  const [exporting, setExporting] = useState(false)

  async function refreshCatalogs() {
    await queryClient.invalidateQueries({ queryKey: ['catalogs', projectId] })
  }
  async function refreshRequirements() {
    // 文件条目状态被多处页面缓存（全局 staleTime 5min + refetchOnWindowFocus:false，
    // 不主动失效就一直是旧数据）：上传/审核/删除后统一失效，避免
    // 「详情已通过、项目页列表仍显示待提交」这类跨页不同步
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['file-requirements'] }), // /files 列表
      queryClient.invalidateQueries({ queryKey: ['project-files'] }), // 项目详情页文件列表
      queryClient.invalidateQueries({ queryKey: ['my-deliverables'] }), // 工作台我的待提交
      queryClient.invalidateQueries({ queryKey: ['deliverable-board'] }), // 交付物催办看板
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] }), // 仪表盘统计
    ])
  }

  // ── 目录 CRUD ──
  async function handleCatalogSave(value: CatalogFormValue) {
    const { parent, node } = catalogDialog
    setSavingCatalog(true)
    try {
      if (node) {
        await FilesService.updateCatalog(projectId, { id: node.id, ...value })
        toast({ description: '目录已更新' })
      } else {
        await FilesService.createCatalog(projectId, {
          ...value,
          parentId: parent?.id ?? null,
        })
        toast({ description: '目录已创建' })
      }
      setCatalogDialog({ open: false, parent: null, node: null })
      await refreshCatalogs()
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSavingCatalog(false)
    }
  }

  async function handleCatalogDelete(node: CatalogNode) {
    if (!(await globalConfirm(`确认删除目录「${node.name}」？需为空目录（无子目录、无条目）。`))) return
    try {
      await FilesService.deleteCatalog(projectId, node.id)
      toast({ description: `目录「${node.name}」已删除` })
      if (selectedCatalogId === node.id) setSelectedCatalogId(null)
      await refreshCatalogs()
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  // ── 条目 CRUD ──
  async function handleRequirementSave(input: RequirementInput) {
    setSavingReq(true)
    try {
      if (reqDialog.item) {
        await FilesService.updateRequirement(reqDialog.item.id, input)
        toast({ description: '文件条目已更新' })
      } else {
        await FilesService.createRequirement(input)
        toast({ description: '文件条目已创建' })
      }
      setReqDialog({ open: false, item: null })
      await Promise.all([refreshRequirements(), refreshCatalogs()])
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSavingReq(false)
    }
  }

  // ── 删除工程第 4 棒：删除文件条目（仅 WAITING；owner/reviewer/ADMIN；服务端终审） ──
  const canDeleteRequirement = (item: FileRequirementItem) =>
    !!me && (me.role === 'ADMIN' || item.ownerId === me.id || item.reviewerId === me.id)

  async function handleRequirementDelete(item: FileRequirementItem) {
    const confirmed = await globalConfirm(
      `确认删除文件条目「${item.name}」？仅未提交（待提交）条目可删除，其关联文件、待办与通知将一并清理，不可恢复。`,
      { title: '删除文件条目', confirmText: '删除', destructive: true },
    )
    if (!confirmed) return
    try {
      await ApiService.delete(`/file-requirements/${item.id}`)
      toast({ description: `文件条目「${item.name}」已删除` })
      if (detailItem?.id === item.id) setDetailItem(null)
      await Promise.all([refreshRequirements(), refreshCatalogs()])
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  async function handleExport() {
    if (!projectId) return
    setExporting(true)
    try {
      const data = await FilesService.getRequirements({
        projectId,
        catalogId: selectedCatalogId ?? undefined,
        status: statusFilter || undefined,
        mine: mineOnly,
        overdue: overdueOnly,
        page: 1,
        limit: 100,
      })
      await exportRequirements(
        data.items.map((r) => ({
          name: r.name,
          code: r.code,
          catalogName: r.catalog.name,
          phaseCode: r.phaseCode,
          ownerName: r.owner?.name ?? null,
          externalOrgName: r.externalOrg?.name ?? null,
          purpose: r.purpose,
          scopeLabel: SCOPE_LABEL[r.scope],
          statusLabel: STATUS_LABEL[r.status],
          dueDate: r.dueDate ? r.dueDate.slice(0, 10) : null,
          required: r.required,
        })),
      )
      toast({ description: `已导出 ${data.items.length} 条文件条目` })
    } catch (err) {
      toast({
        title: '导出失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setExporting(false)
    }
  }

  // ── 渲染 ──
  return (
    <div className="space-y-4">
      {/* 顶部：标题 + 项目选择（统一标题区） */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">文件目录</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">项目：</span>
          <Select value={projectId} onValueChange={(v) => setProjectId(v)}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 定位来源提示条：URL 带 src 时显示，可关闭 */}
      {srcLabel && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 font-normal">
            已定位 · 来自：{srcLabel}
            <button
              type="button"
              onClick={clearFocus}
              className="ml-0.5 text-muted-foreground hover:text-foreground"
              aria-label="关闭定位提示"
            >
              ✕
            </button>
          </Badge>
        </div>
      )}

      {!projectId ? (
        <div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
          请选择（或先创建）一个项目后查看其文件目录
          <div className="mt-2 text-xs">若看不到任何项目，请联系项目经理将你加入项目</div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* 左：目录树 */}
          <aside className="w-full shrink-0 lg:w-64 xl:w-72">
            <CatalogTree
              projectName={
                (() => {
                  const cur = projects.find((p) => p.id === projectId)
                  return cur ? `${cur.code} · ${cur.name}` : undefined
                })()
              }
              nodes={catalogs}
              selectedId={selectedCatalogId}
              onSelect={(node) => setSelectedCatalogId(node?.id ?? null)}
              canEdit={canEdit}
              onAddRoot={() => setCatalogDialog({ open: true, parent: null, node: null })}
              onAddChild={(parent) => setCatalogDialog({ open: true, parent, node: null })}
              onEdit={(node) => setCatalogDialog({ open: true, parent: null, node })}
              onDelete={handleCatalogDelete}
            />
          </aside>

          {/* 右：条目表 */}
          <div className="min-w-0 flex-1">
            {/* 筛选器 + 工具栏 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v === 'ALL' ? '' : v)}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部状态</SelectItem>
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <label className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm">
                <User className="h-4 w-4 text-muted-foreground" />
                <Checkbox checked={mineOnly} onCheckedChange={(v) => setMineOnly(v === true)} />
                我负责
              </label>

              <label className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm">
                <CalendarClock className="h-4 w-4 text-muted-foreground" />
                <Checkbox checked={overdueOnly} onCheckedChange={(v) => setOverdueOnly(v === true)} />
                超期
              </label>

              {selectedCatalogId && (
                <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
                  当前目录筛选
                </span>
              )}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                {canCreate && (
                  <>
                    <Button size="sm" onClick={() => setReqDialog({ open: true, item: null })}>
                      <Plus className="mr-1 h-4 w-4" />
                      新建
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                      <Upload className="mr-1 h-4 w-4" />
                      导入
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting}>
                  <Download className="mr-1 h-4 w-4" />
                  导出
                </Button>
                <Button size="sm" variant="outline" onClick={() => setMatrixOpen(true)}>
                  <Grid3X3 className="mr-1 h-4 w-4" />
                  归档矩阵
                </Button>
              </div>
            </div>

            <RequirementTable
              items={items}
              loading={reqLoading}
              onRowClick={(item) => {
                setSelectedRowId(item.id)
                setDetailItem(item)
              }}
              onEdit={(item) => setReqDialog({ open: true, item })}
              onExplain={(item) => setExplainItem(item)}
              deleteOpts={{
                canDelete: canDeleteRequirement,
                onDelete: handleRequirementDelete,
              }}
              focusId={focusReqId}
              selectedId={selectedRowId}
            />

            {pagination && (
              <TablePagination
                page={pagination.page}
                pages={pagination.pages}
                total={pagination.total}
                onPageChange={setPage}
              />
            )}

            {/* ── 计划外文件（临时文件，W4）── */}
            {selectedCatalogId && (
              <div className="mt-6 rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">临时文件（计划外上传）</h3>
                  {adhocLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  聊天/工作中直接上传、未挂交付条目的文件。可移动到本项目其他目录。
                </p>
                {adhocFiles.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">本目录暂无临时文件</p>
                ) : (
                  <ul className="mt-3 divide-y">
                    {adhocFiles.map((f) => (
                      <li key={f.id} className="flex items-center gap-3 py-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{f.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(f.size / 1024).toFixed(1)} KB · {f.uploadedBy?.name || f.uploadedBy?.email || '未知'}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setMoveDialog({
                              open: true,
                              fileId: f.id,
                              fileName: f.name,
                              targetCatalogId: selectedCatalogId,
                            })
                          }
                        >
                          <FolderInput className="mr-1 h-3.5 w-3.5" />
                          移动到…
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 弹窗 */}
      <Dialog
        open={moveDialog.open}
        onOpenChange={(open) => setMoveDialog((s) => ({ ...s, open }))}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>移动文件</DialogTitle>
            <DialogDescription className="break-all">{moveDialog.fileName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm font-medium">目标目录（本项目内）</p>
              <Select
                value={moveDialog.targetCatalogId}
                onValueChange={(v) => setMoveDialog((s) => ({ ...s, targetCatalogId: v }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择目标目录" />
                </SelectTrigger>
                <SelectContent>
                  {flatCatalogs.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setMoveDialog((s) => ({ ...s, open: false }))}>
                取消
              </Button>
              <Button size="sm" disabled={!moveDialog.targetCatalogId || moving} onClick={handleMove}>
                {moving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FolderInput className="mr-1 h-3.5 w-3.5" />}
                确认移动
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <CatalogDialog
        open={catalogDialog.open}
        onOpenChange={(open) => setCatalogDialog((s) => ({ ...s, open }))}
        parent={catalogDialog.parent}
        node={catalogDialog.node}
        onSave={handleCatalogSave}
        saving={savingCatalog}
      />

      <RequirementFormDialog
        open={reqDialog.open}
        onOpenChange={(open) => setReqDialog((s) => ({ ...s, open }))}
        projectId={projectId}
        catalogs={flatCatalogs}
        members={members}
        externalOrgs={orgs}
        item={reqDialog.item}
        defaultCatalogId={selectedCatalogId ?? flatCatalogs[0]?.id ?? null}
        onSave={handleRequirementSave}
        saving={savingReq}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
        onImported={() => {
          refreshRequirements()
          refreshCatalogs()
        }}
      />

      <FileMatrixDialog open={matrixOpen} onOpenChange={setMatrixOpen} projectId={projectId} />

      <AiExplainDialog
        requirementId={explainItem?.id ?? null}
        requirementName={explainItem?.name}
        open={!!explainItem}
        onOpenChange={(v) => {
          if (!v) setExplainItem(null)
        }}
      />
      <RequirementDetailDrawer
        item={detailItem}
        onClose={closeDetail}
        onChanged={() => {
          void refreshRequirements()
        }}
      />
    </div>
  )
}


export default function FilesPage() {
  return (
    <PageGuard pageKey="files">
      {/* useFocusHighlight 内部用 useSearchParams，静态预渲染需 Suspense 包裹 */}
      <Suspense fallback={null}>
        <FilesPageInner />
      </Suspense>
    </PageGuard>
  )
}
