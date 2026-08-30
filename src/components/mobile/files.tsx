'use client'

/**
 * MobileFiles —— /files 文件目录页移动子树（375-430px）。
 * 双 Tab（交付计划/项目网盘）→ MobileSegmentedTabs；目录树 → 可折叠列表（层级缩进）；
 * 条目表 → 卡片流（MobileList）；筛选收底部 Sheet；操作收「更多」Sheet；新建 FAB。
 * 数据与弹窗全部由页面传入（复用页面 useQuery 与弹窗状态，不重复请求）。
 */

import { useState } from 'react'
import {
  CalendarClock,
  ChevronRight,
  Download,
  FileText,
  Grid3X3,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Upload,
  User,
} from 'lucide-react'

import { Sheet } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MobileSegmentedTabs } from './segmented-tabs'
import { MobileList, MobileListItem } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { MobileEmptyState } from './empty-state'
import { MobileFab } from './fab'
import { DriveExplorer } from '@/components/files/drive-explorer'
import { ALL_STATUSES, STATUS_LABEL } from '@/components/files/badges'
import type { CatalogNode, FileRequirementItem } from '@/types/files'

/** 文件状态 → chip tone（与桌面 Badge 配色语义对齐） */
const STATUS_TONE: Record<string, MobileChipTone> = {
  WAITING: 'default',
  SUBMITTED: 'info',
  REVIEWING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  NA: 'default',
  OBSOLETED: 'default',
}

export interface MobileFilesProps {
  projects: Array<{ id: string; code: string; name: string }>
  projectId: string
  onProjectChange: (id: string) => void
  tab: 'plan' | 'drive'
  onTabChange: (t: 'plan' | 'drive') => void
  catalogs: CatalogNode[]
  flatCatalogs: CatalogNode[]
  selectedCatalogId: string | null
  onSelectCatalog: (id: string | null) => void
  statusFilter: string
  onStatusFilter: (s: string) => void
  mineOnly: boolean
  onMineOnlyChange: (v: boolean) => void
  overdueOnly: boolean
  onOverdueOnlyChange: (v: boolean) => void
  items: FileRequirementItem[]
  loading: boolean
  pagination?: { page: number; pages: number; total: number } | null
  page: number
  onPageChange: (p: number) => void
  canCreate: boolean
  onCreateRequirement: () => void
  onImport: () => void
  onExport: () => void
  onMatrix: () => void
  onOpenDetail: (item: FileRequirementItem) => void
  /** 网盘 Tab 内点交付条目回调（跳回 plan Tab 并开详情） */
  onOpenRequirementFromDrive: (requirementId: string) => void
  /** 临时文件（计划外）区：当前目录的临时文件 + 移动回调 */
  adhocFiles: Array<{ id: string; name: string; size: number; uploadedBy?: { name?: string; email?: string } | null }>
  onMoveAdhoc: (fileId: string, fileName: string) => void
}

/** 目录折叠列表（层级缩进，触控 ≥44px） */
function CatalogAccordion({
  nodes,
  depth,
  selectedCatalogId,
  onSelect,
}: {
  nodes: CatalogNode[]
  depth: number
  selectedCatalogId: string | null
  onSelect: (id: string | null) => void
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const toggle = (id: string) => {
    setOpenIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0
        const open = openIds.has(n.id)
        return (
          <div key={n.id}>
            <div
              className={cn(
                'flex min-h-11 items-center gap-1 rounded-md px-2 py-1',
                selectedCatalogId === n.id && 'bg-primary/10',
              )}
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={open ? '折叠' : '展开'}
                  onClick={() => toggle(n.id)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded active:bg-black/10"
                >
                  <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
                </button>
              ) : (
                <span className="w-8 shrink-0" />
              )}
              <button
                type="button"
                className={cn(
                  'min-w-0 flex-1 truncate py-1.5 text-left text-sm active:bg-muted/60',
                  selectedCatalogId === n.id && 'font-medium text-primary',
                )}
                onClick={() => onSelect(n.id)}
              >
                {n.name}
              </button>
            </div>
            {hasChildren && open && (
              <CatalogAccordion
                nodes={n.children}
                depth={depth + 1}
                selectedCatalogId={selectedCatalogId}
                onSelect={onSelect}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function MobileFiles(props: MobileFilesProps) {
  const {
    projects,
    projectId,
    onProjectChange,
    tab,
    onTabChange,
    catalogs,
    flatCatalogs,
    selectedCatalogId,
    onSelectCatalog,
    statusFilter,
    onStatusFilter,
    mineOnly,
    onMineOnlyChange,
    overdueOnly,
    onOverdueOnlyChange,
    items,
    loading,
    pagination,
    page,
    onPageChange,
    canCreate,
    onCreateRequirement,
    onImport,
    onExport,
    onMatrix,
    onOpenDetail,
    onOpenRequirementFromDrive,
    adhocFiles,
    onMoveAdhoc,
  } = props

  const [filterSheet, setFilterSheet] = useState(false)
  const [moreSheet, setMoreSheet] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(true)

  const selectedCatalog = flatCatalogs.find((c) => c.id === selectedCatalogId)
  const activeFilterCount = (statusFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (overdueOnly ? 1 : 0)

  if (!projectId) {
    return (
      <div className="space-y-3">
        <Select value={projectId} onValueChange={onProjectChange}>
          <SelectTrigger className="min-h-11 w-full">
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
        <MobileEmptyState
          icon={FileText}
          title="请选择项目"
          desc="选择（或先创建）一个项目后查看其文件目录"
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 项目选择行 + 「更多」操作 */}
      <div className="flex items-center gap-2">
        <Select value={projectId} onValueChange={onProjectChange}>
          <SelectTrigger className="min-h-11 min-w-0 flex-1">
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
        <Button
          variant="outline"
          size="sm"
          className="h-11 shrink-0 px-3"
          onClick={() => setMoreSheet(true)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>

      {/* 双 Tab */}
      <MobileSegmentedTabs
        tabs={[
          { key: 'plan', label: '交付计划' },
          { key: 'drive', label: '📁 项目网盘' },
        ]}
        active={tab}
        onChange={(k) => onTabChange(k as 'plan' | 'drive')}
      />

      {tab === 'plan' ? (
        <>
          {/* 目录折叠区 */}
          <div className="rounded-lg border bg-card">
            <button
              type="button"
              onClick={() => setCatalogOpen((v) => !v)}
              className="flex min-h-12 w-full items-center gap-2 px-3 text-sm font-medium"
            >
              <ChevronRight className={cn('h-4 w-4 transition-transform', catalogOpen && 'rotate-90')} />
              目录
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                · {selectedCatalog ? selectedCatalog.name : '全部'}
              </span>
              {selectedCatalogId && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectCatalog(null)
                  }}
                  className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                >
                  清除
                </button>
              )}
            </button>
            {catalogOpen && (
              <div className="border-t p-2">
                <CatalogAccordion
                  nodes={catalogs}
                  depth={0}
                  selectedCatalogId={selectedCatalogId}
                  onSelect={onSelectCatalog}
                />
              </div>
            )}
          </div>

          {/* 筛选行 */}
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 w-full justify-start"
            onClick={() => setFilterSheet(true)}
          >
            <SlidersHorizontal className="mr-1 h-4 w-4" />
            筛选
            <span className="ml-1 truncate text-muted-foreground">
              {statusFilter ? STATUS_LABEL[statusFilter as keyof typeof STATUS_LABEL] : '全部状态'}
              {mineOnly ? ' · 我负责' : ''}
              {overdueOnly ? ' · 超期' : ''}
            </span>
            {activeFilterCount > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>

          {/* 条目卡片流 */}
          <MobileList
            items={items}
            keyOf={(it) => it.id}
            loading={loading}
            empty={
              <MobileEmptyState
                icon={FileText}
                title="暂无文件条目"
                desc="调整筛选或选择其他目录试试"
              />
            }
            renderItem={(it) => (
              <MobileListItem
                title={it.name}
                subtitle={
                  <span>
                    {[it.code, it.phaseCode, it.owner?.name].filter(Boolean).join(' · ') || '—'}
                    {it.dueDate ? ` · 截止 ${it.dueDate.slice(0, 10)}` : ''}
                  </span>
                }
                status={
                  <MobileStatusChip
                    label={STATUS_LABEL[it.status] ?? it.status}
                    tone={STATUS_TONE[it.status] ?? 'default'}
                  />
                }
                onClick={() => onOpenDetail(it)}
              />
            )}
          />

          {/* 分页（触控 ≥44px） */}
          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-between gap-2 px-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 flex-1"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                上一页
              </Button>
              <span className="shrink-0 px-2 text-xs text-muted-foreground">
                {pagination.page}/{pagination.pages} · 共{pagination.total}条
              </span>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 flex-1"
                disabled={page >= pagination.pages}
                onClick={() => onPageChange(page + 1)}
              >
                下一页
              </Button>
            </div>
          )}

          {/* 临时文件（计划外上传）区 */}
          {selectedCatalogId && adhocFiles.length > 0 && (
            <div className="rounded-lg border bg-card p-3">
              <h3 className="text-sm font-semibold">临时文件（计划外上传）</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                聊天/工作中直接上传、未挂交付条目的文件，可移动到其他目录。
              </p>
              <div className="mt-2 divide-y">
                {adhocFiles.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 py-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{f.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(f.size / 1024).toFixed(1)} KB · {f.uploadedBy?.name || f.uploadedBy?.email || '未知'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0"
                      onClick={() => onMoveAdhoc(f.id, f.name)}
                    >
                      移动
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 新建 FAB */}
          {canCreate && <MobileFab icon={Plus} label="新建条目" onClick={onCreateRequirement} />}
        </>
      ) : (
        /* 项目网盘（DriveExplorer 自带 lg 断点：树收下拉 + 网格自适应） */
        <div className="h-[calc(100dvh-15rem)] min-h-[420px]">
          <DriveExplorer projectId={projectId} onOpenRequirement={onOpenRequirementFromDrive} />
        </div>
      )}

      {/* 筛选 Sheet */}
      <Sheet open={filterSheet} onClose={() => setFilterSheet(false)} title="筛选">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">状态</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onStatusFilter('')}
                className={cn(
                  'min-h-11 rounded-full px-4 text-sm',
                  !statusFilter
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground active:bg-muted/70',
                )}
              >
                全部
              </button>
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStatusFilter(s)}
                  className={cn(
                    'min-h-11 rounded-full px-4 text-sm',
                    statusFilter === s
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground active:bg-muted/70',
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">范围</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onMineOnlyChange(!mineOnly)}
                className={cn(
                  'flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm',
                  mineOnly
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground active:bg-muted/70',
                )}
              >
                <User className="h-4 w-4" /> 我负责
              </button>
              <button
                type="button"
                onClick={() => onOverdueOnlyChange(!overdueOnly)}
                className={cn(
                  'flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm',
                  overdueOnly
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground active:bg-muted/70',
                )}
              >
                <CalendarClock className="h-4 w-4" /> 仅超期
              </button>
            </div>
          </div>
        </div>
      </Sheet>

      {/* 更多操作 Sheet（新建 / 导入 / 导出 / 归档矩阵） */}
      <Sheet open={moreSheet} onClose={() => setMoreSheet(false)} title="更多操作">
        <div className="divide-y">
          {canCreate && (
            <button
              type="button"
              onClick={() => {
                setMoreSheet(false)
                onCreateRequirement()
              }}
              className="flex min-h-12 w-full items-center gap-3 px-1 py-3 text-left text-sm active:bg-muted/60"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <Plus className="h-4 w-4" />
              </span>
              新建文件条目
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => {
                setMoreSheet(false)
                onImport()
              }}
              className="flex min-h-12 w-full items-center gap-3 px-1 py-3 text-left text-sm active:bg-muted/60"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <Upload className="h-4 w-4" />
              </span>
              导入 Excel
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMoreSheet(false)
              onExport()
            }}
            className="flex min-h-12 w-full items-center gap-3 px-1 py-3 text-left text-sm active:bg-muted/60"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
              <Download className="h-4 w-4" />
            </span>
            导出 Excel
          </button>
          <button
            type="button"
            onClick={() => {
              setMoreSheet(false)
              onMatrix()
            }}
            className="flex min-h-12 w-full items-center gap-3 px-1 py-3 text-left text-sm active:bg-muted/60"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
              <Grid3X3 className="h-4 w-4" />
            </span>
            归档矩阵
          </button>
        </div>
      </Sheet>
    </div>
  )
}
