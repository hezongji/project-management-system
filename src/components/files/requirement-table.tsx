'use client'

/**
 * RequirementTable —— 文件条目表（§8.2④，TanStack Table）
 *
 * 列：名称/编号/责任人/用途/范围/状态/截止/操作。
 * 行点击 → 条目详情抽屉；操作列「编辑」按 permissions.edit 显隐。
 * 截止列超期（dueDate < 今天 且状态未完结）红色高亮。
 */

import { ColumnDef } from '@tanstack/react-table'
import { Pencil, Sparkles, Trash2 } from 'lucide-react'

import { DataTable } from '@/components/ui/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { STATUS_BADGE, SCOPE_BADGE } from './badges'
import type { FileRequirementItem } from '@/types/files'

const FINAL_STATUS = new Set(['APPROVED', 'NA', 'OBSOLETED'])

function isOverdue(item: FileRequirementItem): boolean {
  if (!item.dueDate || FINAL_STATUS.has(item.status)) return false
  const d = new Date(item.dueDate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d < today
}

/** 删除权限判定（删除工程第 4 棒）：ADMIN / 条目责任人 / 审核人（近似显示，服务端终审） */
export interface DeleteOpts {
  canDelete?: (item: FileRequirementItem) => boolean
  onDelete?: (item: FileRequirementItem) => void
}

export function buildRequirementColumns(
  onEdit: (item: FileRequirementItem) => void,
  onExplain: (item: FileRequirementItem) => void = () => {},
  deleteOpts: DeleteOpts = {},
): ColumnDef<FileRequirementItem, unknown>[] {
  return [
    {
      id: 'name',
      header: '名称',
      accessorFn: (r) => r.name,
      cell: ({ row }) => {
        const r = row.original
        const v = r.files[0]
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium" title={r.name}>
                {r.name}
              </span>
              {!r.required && (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">非必需</span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {v ? `最新 v${v.version}` : '未上传'}
            </div>
          </div>
        )
      },
    },
    {
      id: 'code',
      header: '编号',
      accessorFn: (r) => r.code ?? '',
      meta: { className: 'hidden md:table-cell' },
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">{row.original.code ?? '—'}</span>
      ),
    },
    {
      id: 'owner',
      header: '责任人',
      accessorFn: (r) => r.owner?.name ?? '',
      meta: { className: 'hidden md:table-cell' },
      cell: ({ row }) => <span className="text-sm">{row.original.owner?.name ?? '—'}</span>,
    },
    {
      id: 'purpose',
      header: '用途',
      accessorFn: (r) => r.purpose ?? '',
      meta: { className: 'hidden lg:table-cell' },
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{row.original.purpose ?? '—'}</span>
      ),
    },
    {
      id: 'scope',
      header: '范围',
      accessorFn: (r) => r.scope,
      meta: { className: 'hidden md:table-cell' },
      cell: ({ row }) => {
        const b = SCOPE_BADGE[row.original.scope]
        return (
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', b.cls)}>
            {b.label}
          </span>
        )
      },
    },
    {
      id: 'status',
      header: '状态',
      accessorFn: (r) => r.status,
      cell: ({ row }) => {
        const b = STATUS_BADGE[row.original.status]
        return (
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', b.cls)}>
            {b.label}
          </span>
        )
      },
    },
    {
      id: 'dueDate',
      header: '截止',
      accessorFn: (r) => r.dueDate ?? '',
      cell: ({ row }) => {
        const r = row.original
        const overdue = isOverdue(r)
        return (
          <span className={cn('text-xs', overdue && 'font-semibold text-red-600')}>
            {r.dueDate ? r.dueDate.slice(0, 10) : '—'}
            {overdue && <span className="ml-1">超期</span>}
          </span>
        )
      },
    },
    {
      id: 'actions',
      header: '操作',
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original
        return (
          <div className="flex items-center gap-1">
            {/* AI 解读：只读能力，所有可见用户可用（后端可见性校验） */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onExplain(r)
              }}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />
              解读
            </Button>
            {r.permissions.edit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(r)
                }}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                编辑
              </Button>
            )}
            {/* 删除工程第 4 棒：仅 WAITING 可删；已进入流程的禁用并提示改用作废/驳回 */}
            {deleteOpts.canDelete?.(r) &&
              (r.status === 'WAITING' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteOpts.onDelete?.(r)
                  }}
                  title="删除该条目（仅未提交状态可删，不可恢复）"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground/60"
                  disabled
                  title="已提交至流程，不可物理删除；请改用「作废」或「驳回」保留审核记录"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              ))}
          </div>
        )
      },
    },
  ]
}

export function RequirementTable({
  items,
  loading,
  onRowClick,
  onEdit,
  onExplain = () => {},
  deleteOpts = {},
  focusId,
  selectedId,
}: {
  items: FileRequirementItem[]
  loading: boolean
  onRowClick: (item: FileRequirementItem) => void
  onEdit: (item: FileRequirementItem) => void
  onExplain?: (item: FileRequirementItem) => void
  deleteOpts?: DeleteOpts
  /** 跨页定位：与条目 id 匹配时行高亮 + 滚动（useFocusHighlight 约定） */
  focusId?: string | null
  /** 持久选中行：点击行/跳转定位后保持选中高亮，点击其他行自动切换 */
  selectedId?: string | null
}) {
  const columns = buildRequirementColumns(onEdit, onExplain, deleteOpts)
  return (
    <DataTable<FileRequirementItem>
      columns={columns}
      data={items}
      loading={loading}
      empty="暂无文件条目"
      onRowClick={onRowClick}
      focusId={focusId}
      selectedId={selectedId}
      getRowId={(item) => item.id}
    />
  )
}

// 供归档矩阵等复用
export { Badge }
