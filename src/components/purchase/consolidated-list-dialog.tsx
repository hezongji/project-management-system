'use client'

/**
 * 项目采购总清单（合并汇总）弹窗 —— ★ 2026-08-25 归档/复用/成本核算
 *
 * 选项目 → GET /api/purchase-orders/consolidated 把该项目全部已采购订单明细
 * 合并成三大类（机械/电气/其他）总清单（同类项数量/金额累加）：
 *   - 项目执行中随时可生成（阶段性合并，灵活，不限结项）
 *   - 可一键导出 Excel（分区小计 + 汇总 sheet），供结项归档与后续项目复用/成本核算
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/mobile/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { exportConsolidatedPurchase } from '@/lib/excel-templates'
import { Cog, Download, FileStack, Loader2, Zap, Package } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ConsolidatedData {
  project: { id: string; code: string; name: string }
  includeDraft: boolean
  orderCount: number
  categories: Array<{
    category: string
    label: string
    orderCount: number
    itemCount: number
    totalQty: number
    totalAmount: number | null
    items: Array<{
      name: string
      spec: string | null
      param: string | null
      brand: string | null
      unit: string
      totalQty: number
      avgUnitPrice: number | null
      totalAmount: number | null
      batchCount: number
      orderCodes: string[]
      lastPurchasedAt: string | null
    }>
  }>
  summary: { totalAmount: number | null; totalItems: number; generatedAt: string }
}

const CAT_ICON: Record<string, React.ReactNode> = {
  MECHANICAL: <Cog className="h-3.5 w-3.5" />,
  ELECTRICAL: <Zap className="h-3.5 w-3.5" />,
  OTHER: <Package className="h-3.5 w-3.5" />,
}

export interface ConsolidatedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 外部已选项目（采购页筛选）时直接带入 */
  defaultProjectId?: string | null
}

export function ConsolidatedListDialog({ open, onOpenChange, defaultProjectId }: ConsolidatedDialogProps) {
  const { toast } = useToast()
  const [projectId, setProjectId] = React.useState(defaultProjectId ?? '')
  const [includeDraft, setIncludeDraft] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? '')
      setIncludeDraft(false)
    }
  }, [open, defaultProjectId])

  const { data: projects = [] } = useQuery({
    queryKey: ['wb-projects'],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; code: string; name: string }> }>('/projects?limit=100')
        .then((r) => r.data?.items ?? []),
    enabled: open,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['consolidated-purchase', projectId, includeDraft],
    queryFn: () =>
      ApiService.get<ConsolidatedData>(
        `/purchase-orders/consolidated?projectId=${projectId}${includeDraft ? '&includeDraft=1' : ''}`,
      ).then((r) => r.data as ConsolidatedData),
    enabled: open && !!projectId,
  })

  const doExport = async () => {
    if (!data || exporting) return
    setExporting(true)
    try {
      await exportConsolidatedPurchase(
        data,
        new Date(data.summary.generatedAt).toLocaleString('zh-CN'),
      )
      toast({ description: `已导出「${data.project.code}」采购总清单（${data.summary.totalItems} 种物料）` })
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  const fmtMoney = (n: number | null) =>
    n == null ? '—' : `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileStack className="h-5 w-5 text-primary" /> 项目采购总清单（合并汇总）
          </DialogTitle>
          <DialogDescription>
            把项目下所有已采购订单明细合并为机械/电气/其他三大类总清单（多批次同类项自动累加），
            项目执行中可随时生成阶段性汇总，也可用于结项归档与成本核算
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-9 min-w-[240px] flex-1 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">选择项目…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeDraft}
              onChange={(e) => setIncludeDraft(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            含草稿订单
          </label>
          {data && (
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary">{data.orderCount} 张订单</Badge>
              <Badge variant="secondary">{data.summary.totalItems} 种物料</Badge>
              <Badge variant="default">{fmtMoney(data.summary.totalAmount)}</Badge>
              <Button size="sm" onClick={doExport} disabled={exporting}>
                {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                导出 Excel
              </Button>
            </div>
          )}
        </div>

        {!projectId ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            请先选择项目；合并口径为该项目下所有已下单订单（不含草稿，可勾选包含）
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在合并汇总…
          </div>
        ) : !data || data.categories.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            该项目还没有已采购的订单；下单后再来合并
          </div>
        ) : (
          <div className="space-y-4">
            {data.categories.map((cat) => (
              <div key={cat.category} className="overflow-hidden rounded-md border">
                <div className="flex items-center justify-between gap-2 bg-muted/60 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    {CAT_ICON[cat.category]}
                    {cat.label}类
                    <span className="text-xs font-normal text-muted-foreground">
                      {cat.orderCount} 张订单 · {cat.itemCount} 种物料 · 共 {cat.totalQty} 件
                    </span>
                  </p>
                  <Badge variant="outline" className="text-xs">{fmtMoney(cat.totalAmount)}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-left text-muted-foreground">
                      <tr>
                        <th className="w-10 px-2 py-1.5 font-medium">序号</th>
                        <th className="px-2 py-1.5 font-medium">名称</th>
                        <th className="px-2 py-1.5 font-medium">型号</th>
                        <th className="px-2 py-1.5 font-medium">参数</th>
                        <th className="px-2 py-1.5 font-medium">品牌</th>
                        <th className="w-16 px-2 py-1.5 font-medium">单位</th>
                        <th className="w-20 px-2 py-1.5 text-right font-medium">累计数量</th>
                        <th className="w-20 px-2 py-1.5 text-right font-medium">均价(元)</th>
                        <th className="w-24 px-2 py-1.5 text-right font-medium">累计金额</th>
                        <th className="w-16 px-2 py-1.5 text-right font-medium">批次</th>
                        <th className="hidden px-2 py-1.5 font-medium lg:table-cell">涉及订单</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cat.items.map((it, i) => (
                        <tr key={i} className="border-t hover:bg-muted/30">
                          <td className="px-2 py-1.5 text-center text-muted-foreground">{i + 1}</td>
                          <td className="px-2 py-1.5 font-medium">{it.name}</td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{it.spec ?? '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{it.param ?? '—'}</td>
                          <td className="px-2 py-1.5">{it.brand ?? '—'}</td>
                          <td className="px-2 py-1.5">{it.unit}</td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">{it.totalQty}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{it.avgUnitPrice ?? '—'}</td>
                          <td className={cn('px-2 py-1.5 text-right font-mono', it.totalAmount != null && 'font-semibold')}>
                            {fmtMoney(it.totalAmount)}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground">{it.batchCount}</td>
                          <td className="hidden max-w-[14em] truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground lg:table-cell" title={it.orderCodes.join('、')}>
                            {it.orderCodes.join('、')}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t bg-muted/40">
                        <td colSpan={6} className="px-2 py-1.5 text-right font-medium">{cat.label}类小计</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold">{cat.totalQty}</td>
                        <td />
                        <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtMoney(cat.totalAmount)}</td>
                        <td colSpan={2} />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <p className="text-right text-sm">
              总计（三大类）：<span className="font-mono font-bold">{fmtMoney(data.summary.totalAmount)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                生成于 {new Date(data.summary.generatedAt).toLocaleString('zh-CN')}
              </span>
            </p>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
