'use client'

/**
 * 供应商需求（品牌采购任务）详情/流转弹窗（2026-08-25 修复导入链路断裂）
 *
 * 功能：查看任务明细 → 录入报价（quote）→ 转订单（order，自动生成 DRAFT 采购订单 CG-*）
 *      → 取消（cancel）；删除复用列表已有入口。
 * 权限：流转按钮仅采购部/ADMIN 可见（后端终审）；金额字段后端按权限脱敏。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, BadgeCent, ShoppingCart, XCircle, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiService } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'

const SR_STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'bg-muted text-muted-foreground' },
  PUBLISHED: { label: '已发布', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  QUOTED: { label: '已报价', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  ORDERED: { label: '已下单', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  CANCELLED: { label: '已取消', cls: 'bg-muted text-muted-foreground line-through' },
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN')}`

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('zh-CN') : '—'

interface SrItem {
  id: string
  name: string
  spec: string | null
  param: string | null
  brand: string | null
  quantity: number | string
  unit: string
  unitPrice: number | string | null
  remark: string | null
}

interface SrDetail {
  id: string
  code: string
  title: string | null
  brand: string | null
  status: string
  remark: string | null
  quoteAmount: number | null
  quoteNote: string | null
  quotedAt: string | null
  createdAt: string
  category: string
  supplier: { id: string; name: string } | null
  supplierId: string | null
  creator: { id: string; name: string } | null
  project: { id: string; code: string; name: string }
  request: { id: string; code: string; title: string } | null
  order: { id: string; code: string; status: string } | null
  items: SrItem[]
}

export interface SupplierRequestDetailDialogProps {
  srId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
  /** 转订单成功后跳转查看订单（切到订单 tab 并打开详情） */
  onViewOrder?: (orderId: string) => void
}

export function SupplierRequestDetailDialog({
  srId,
  open,
  onOpenChange,
  onChanged,
  onViewOrder,
}: SupplierRequestDetailDialogProps) {
  const user = useAuthStore((s) => s.user)
  const { toast } = useToast()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const isPurchase =
    user?.role === 'ADMIN' || (user?.department?.name ?? '').includes('采购')

  // 报价表单
  const [quoteAmount, setQuoteAmount] = React.useState('')
  const [quoteNote, setQuoteNote] = React.useState('')
  const [acting, setActing] = React.useState(false)
  React.useEffect(() => {
    if (open) {
      setQuoteAmount('')
      setQuoteNote('')
    }
  }, [open, srId])

  const { data: sr, isLoading } = useQuery({
    queryKey: ['supplier-request-detail', srId],
    queryFn: () => ApiService.get<SrDetail>(`/supplier-requests/${srId}`).then((r) => r.data),
    enabled: open && !!srId,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['supplier-request-detail', srId] })
    queryClient.invalidateQueries({ queryKey: ['supplier-requests'] })
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
    onChanged?.()
  }

  // ★ 2026-08-25：指定/调整供应商（采购人员按品牌归供应商；已转订单不可改）
  const [supplierSaving, setSupplierSaving] = React.useState(false)
  const { data: supplierOpts = [] } = useQuery({
    queryKey: ['sr-detail-suppliers'],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; name: string }> }>('/external-orgs?type=SUPPLIER&limit=200')
        .then((r) => ((r.data as unknown as { items?: Array<{ id: string; name: string }> })?.items ?? (r.data as unknown as Array<{ id: string; name: string }>))),
    enabled: open && isPurchase,
  })
  const changeSupplier = async (v: string) => {
    if (!srId || supplierSaving) return
    setSupplierSaving(true)
    try {
      const res = await ApiService.patch(`/supplier-requests/${srId}`, { supplierId: v === 'none' ? null : v })
      toast({ title: res.message ?? '供应商已更新', description: v === 'none' ? undefined : supplierOpts.find((s) => s.id === v)?.name })
      refresh()
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (e as Error).message
      toast({ title: '指定供应商失败', description: msg, variant: 'destructive' })
    } finally {
      setSupplierSaving(false)
    }
  }

  // ── 流转动作（PATCH /supplier-requests/[id]）──
  const act = async (action: 'quote' | 'order' | 'cancel', extra?: Record<string, unknown>) => {
    if (!srId || acting) return
    setActing(true)
    try {
      const res = await ApiService.patch<SrDetail>(`/supplier-requests/${srId}`, { action, ...extra })
      const orderInfo = res.data?.order
      toast({ title: res.message ?? '操作成功' })
      refresh()
      // 转订单成功：提示 + 支持跳转
      if (action === 'order' && orderInfo?.id) {
        onViewOrder?.(orderInfo.id)
      }
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (e as Error).message
      toast({ title: '操作失败', description: msg, variant: 'destructive' })
    } finally {
      setActing(false)
    }
  }

  const doQuote = () => {
    const n = Number(quoteAmount)
    if (!Number.isFinite(n) || n <= 0) {
      toast({ variant: 'destructive', description: '请填写有效的报价金额' })
      return
    }
    act('quote', { quoteAmount: n, quoteNote: quoteNote.trim() || null })
  }

  const doOrder = () => {
    confirm.ask(
      '转采购订单',
      `将根据本任务明细自动生成采购订单（草稿起步，后续走「发起合同 → 确认 → 正式下单」流程）。确认转订单？`,
      () => act('order'),
      { confirmText: '转订单' },
    )
  }

  const doCancel = () => {
    confirm.ask(
      '取消采购任务',
      `取消后本任务将作废（已关联的订单不受影响）。确认取消 ${sr?.code ?? ''}？`,
      () => act('cancel'),
      { confirmText: '取消任务', destructive: true },
    )
  }

  if (!srId) return null
  const meta = SR_STATUS_META[sr?.status ?? ''] ?? { label: sr?.status ?? '', cls: '' }
  const num = (v: number | string | null | undefined) =>
    v == null ? null : Number(v)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{sr?.code ?? '…'}</span>
            {sr && <Badge className={cn('text-xs', meta.cls)}>{meta.label}</Badge>}
            {sr?.brand && <Badge variant="outline" className="text-xs">{sr.brand}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {sr ? `${sr.title ?? '品牌采购任务'} · 来自${sr.request ? `清单 ${sr.request.code}` : '独立发起'}` : '加载中…'}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !sr ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* 概要 */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border p-3 text-xs sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground">项目</p>
                <p className="mt-0.5"><span className="font-mono text-primary">{sr.project.code}</span> {sr.project.name}</p>
              </div>
              <div>
                <p className="text-muted-foreground">供应商</p>
                <div className="mt-0.5">
                  {isPurchase && sr.status !== 'ORDERED' && sr.status !== 'CANCELLED' ? (
                    <Select
                      value={sr.supplierId ?? 'none'}
                      onValueChange={changeSupplier}
                      disabled={supplierSaving}
                    >
                      <SelectTrigger className="h-7 w-40 text-xs">
                        <SelectValue placeholder="指定供应商" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">待分配</SelectItem>
                        {supplierOpts.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span>{sr.supplier?.name ?? '待分配'}</span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">创建人</p>
                <p className="mt-0.5">{sr.creator?.name ?? '—'} · {fmtDate(sr.createdAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">报价金额</p>
                <p className="mt-0.5 font-mono">{fmtMoney(sr.quoteAmount)}{sr.quotedAt && <span className="ml-1 text-muted-foreground">({fmtDate(sr.quotedAt)})</span>}</p>
              </div>
              <div>
                <p className="text-muted-foreground">关联订单</p>
                <p className="mt-0.5 font-mono">
                  {sr.order ? (
                    <span className="text-primary">{sr.order.code}</span>
                  ) : (
                    <span className="text-muted-foreground">未生成</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">明细行数</p>
                <p className="mt-0.5">{sr.items.length} 行</p>
              </div>
            </div>

            {sr.quoteNote && (
              <p className="rounded bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">报价说明：{sr.quoteNote}</p>
            )}
            {sr.remark && (
              <p className="rounded bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">备注：{sr.remark}</p>
            )}

            {/* 明细表 */}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">物料名称</th>
                    <th className="px-3 py-2 font-medium">规格/参数</th>
                    <th className="px-3 py-2 text-right font-medium">数量</th>
                    <th className="px-3 py-2 text-right font-medium">单价</th>
                    <th className="px-3 py-2 text-right font-medium">小计</th>
                  </tr>
                </thead>
                <tbody>
                  {sr.items.map((it) => {
                    const qty = num(it.quantity) ?? 0
                    const price = num(it.unitPrice)
                    return (
                      <tr key={it.id} className="border-t">
                        <td className="px-3 py-2">
                          <span className="font-medium">{it.name}</span>
                          {it.brand && <span className="ml-1 text-muted-foreground">[{it.brand}]</span>}
                          {it.remark && <p className="text-[11px] text-muted-foreground">{it.remark}</p>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {[it.spec, it.param].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 py-2 text-right">{qty} {it.unit}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtMoney(price)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {price != null ? fmtMoney(qty * price) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* 报价录入（PUBLISHED/DRAFT 且有权时显示） */}
            {isPurchase && (sr.status === 'PUBLISHED' || sr.status === 'DRAFT') && (
              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-xs font-medium">录入报价</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-40 space-y-1">
                    <Label className="text-xs">报价总额（元）</Label>
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="如 12800"
                      value={quoteAmount}
                      onChange={(e) => setQuoteAmount(e.target.value)}
                    />
                  </div>
                  <div className="min-w-[200px] flex-1 space-y-1">
                    <Label className="text-xs">报价说明（可选）</Label>
                    <Input
                      className="h-8 text-xs"
                      placeholder="如 含税含运费，货期 15 天"
                      value={quoteNote}
                      onChange={(e) => setQuoteNote(e.target.value)}
                    />
                  </div>
                  <Button size="sm" className="h-8" onClick={doQuote} disabled={acting}>
                    {acting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <BadgeCent className="mr-1 h-3.5 w-3.5" />}
                    确认报价
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  可选：先在明细表核对单价（转订单时按明细单价 × 数量计算订单金额）
                </p>
              </div>
            )}

            <DialogFooter className="flex-wrap gap-2">
              {sr.order && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onViewOrder?.(sr.order!.id)}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> 查看订单 {sr.order.code}
                </Button>
              )}
              {isPurchase && !sr.order && (sr.status === 'QUOTED' || sr.status === 'PUBLISHED') && (
                <Button size="sm" onClick={doOrder} disabled={acting}>
                  {acting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShoppingCart className="mr-1 h-3.5 w-3.5" />}
                  转采购订单
                </Button>
              )}
              {isPurchase && !sr.order && sr.status !== 'CANCELLED' && sr.status !== 'ORDERED' && (
                <Button size="sm" variant="outline" onClick={doCancel} disabled={acting}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> 取消任务
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
            </DialogFooter>
          </div>
        )}
        {confirm.render}
      </DialogContent>
    </Dialog>
  )
}
