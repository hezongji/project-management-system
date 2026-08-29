'use client'

/**
 * DataTable —— 基于 @tanstack/react-table v8 的通用表格（§8.2 组件契约）
 *
 * 内置：点击表头客户端排序、加载骨架、空态、行点击。
 * 分页由外部控制（服务端分页场景），搭配 <TablePagination /> 使用。
 */

import * as React from 'react'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DataTable<TData extends object>({
  columns,
  data,
  loading = false,
  empty = '暂无数据',
  onRowClick,
  className,
  focusId,
  selectedId,
  getRowId,
}: {
  columns: ColumnDef<TData, any>[]
  data: TData[]
  loading?: boolean
  empty?: string
  onRowClick?: (row: TData) => void
  className?: string
  /** 跨页定位：命中行高亮闪烁 + 滚动（useFocusHighlight 约定；同一 focusId 只闪一次） */
  focusId?: string | null
  /** 持久选中行：与 getRowId 匹配的行保持选中高亮（由页面在 onRowClick 中维护，点击即切换） */
  selectedId?: string | null
  getRowId?: (row: TData) => string
}) {
  const [sorting, setSorting] = React.useState<SortingState>([])

  // 定位闪烁：目标行出现在数据中时高亮 3.4s 并滚动一次；
  // flashedRef 防止 data 引用变化（重新拉取/翻页回来）导致同一 focusId 反复重闪旧行
  const [flashOn, setFlashOn] = React.useState(false)
  const scrolledRef = React.useRef(false)
  const flashedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!focusId || !getRowId) return
    if (flashedRef.current === focusId) return
    if (!data.some((d) => getRowId(d) === focusId)) return
    flashedRef.current = focusId
    scrolledRef.current = false
    setFlashOn(true)
    const t = setTimeout(() => setFlashOn(false), 3400)
    return () => clearTimeout(t)
  }, [focusId, data, getRowId])

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className={cn('overflow-hidden rounded-xl border', className)}>
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b bg-muted/60 hover:bg-muted/60">
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        'h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
                        (header.column.columnDef.meta as { className?: string } | undefined)?.className
                      )}
                      onClick={
                        sortable ? header.column.getToggleSortingHandler() : undefined
                      }
                    >
                      {header.isPlaceholder ? null : (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1',
                            sortable && 'cursor-pointer select-none hover:text-foreground'
                          )}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortable &&
                            (sorted === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUpDown className="h-3 w-3 opacity-40" />
                            ))}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  加载中…
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const rowId = getRowId ? getRowId(row.original) : undefined
                const rowHit = !!flashOn && !!focusId && rowId === focusId
                const rowSelected = !!selectedId && rowId === selectedId
                return (
                <tr
                  key={row.id}
                  data-focus-id={rowId}
                  ref={
                    rowHit
                      ? (el) => {
                          if (el && !scrolledRef.current) {
                            scrolledRef.current = true
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          }
                        }
                      : undefined
                  }
                  aria-selected={rowSelected || undefined}
                  className={cn(
                    'border-b transition-colors hover:bg-muted/50',
                    onRowClick && 'cursor-pointer',
                    rowSelected &&
                      'bg-primary/[0.06] shadow-[inset_2px_0_0_0_hsl(var(--primary))] hover:bg-primary/[0.10]',
                    rowHit && 'focus-ring-flash'
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cn('px-3 py-2.5 align-middle', (cell.column.columnDef.meta as { className?: string } | undefined)?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 服务端分页控件（与 §4 分页约定配套） */
export function TablePagination({
  page,
  pages,
  total,
  onPageChange,
}: {
  page: number
  pages: number
  total: number
  onPageChange: (page: number) => void
}) {
  return (
    <div className="flex items-center justify-between px-1 py-3 text-sm text-muted-foreground">
      <span>
        共 {total} 条 · 第 {page}/{Math.max(pages, 1)} 页
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}
