'use client'

/**
 * 付款登记弹窗（★ V3 P0 2026-08-22，工作流第⑤⑥步）
 *
 * advanceMode=true  推进状态（ORDERED→PREPARING）：PATCH advance { action: MARK_PREPARING, payment }
 * advanceMode=false 单纯补登付款流水：POST /api/purchase-payments
 * 弹窗内附该订单付款流水列表（仅采购/财务/ADMIN 可见，API 层鉴权）。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Banknote } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  PREPAYMENT: '预付款',
  FULL: '全款',
  TAIL: '尾款',
  REFUND: '退款冲减',
}

interface PaymentRow {
  id: string
  type: string
  amount: number
  status: string
  method: string | null
  voucherNo: string | null
  paidAt: string
  remark: string | null
  createdBy: { name: string } | null
}

interface PaymentsResp {
  items: PaymentRow[]
  paidAmount: number
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—')

export interface PaymentFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  orderCode: string
  /** true=推进状态（下单→备货中）；false=仅补登流水 */
  advanceMode?: boolean
  /** 是否显示流水列表（仅采购/财务/ADMIN） */
  canViewList?: boolean
  onSaved?: () => void
}

export function PaymentFormDialog({
  open,
  onOpenChange,
  orderId,
  orderCode,
  advanceMode = false,
  canViewList = true,
  onSaved,
}: PaymentFormDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  const [type, setType] = React.useState('PREPAYMENT')
  const [amount, setAmount] = React.useState('')
  const [paidAt, setPaidAt] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [method, setMethod] = React.useState('')
  const [voucherNo, setVoucherNo] = React.useState('')
  const [remark, setRemark] = React.useState('')

  React.useEffect(() => {
    if (open) {
      setType('PREPAYMENT')
      setAmount('')
      setPaidAt(new Date().toISOString().slice(0, 10))
      setMethod('')
      setVoucherNo('')
      setRemark('')
    }
  }, [open])

  // 付款流水列表（仅采购/财务/ADMIN；API 会拒绝其他人）
  const { data: payData } = useQuery({
    queryKey: ['purchase-payments', orderId],
    queryFn: () =>
      ApiService.get<PaymentsResp>(`/purchase-payments?orderId=${orderId}`).then((r) => r.data),
    enabled: open && !!orderId && canViewList,
  })

  const submit = async () => {
    if (saving) return
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ variant: 'destructive', description: '请填写正确的付款金额' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        type,
        amount: amt,
        paidAt: new Date(paidAt).toISOString(),
        ...(method.trim() && { method: method.trim() }),
        ...(voucherNo.trim() && { voucherNo: voucherNo.trim() }),
        ...(remark.trim() && { remark: remark.trim() }),
      }
      if (advanceMode) {
        await ApiService.patch(`/purchase-orders/${orderId}/advance`, {
          action: 'MARK_PREPARING',
          payment: payload,
        })
        toast({ description: '付款已登记，订单进入「备货中」✓' })
      } else {
        await ApiService.post('/purchase-payments', { orderId, ...payload })
        toast({ description: '付款流水已登记 ✓' })
      }
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-payments', orderId] })
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '登记失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-amber-500" />
            {advanceMode ? '登记付款 · 推进备货' : '补登付款流水'} · {orderCode}
          </DialogTitle>
          <DialogDescription>
            {advanceMode
              ? '登记预付款/全款后订单推进为「已付款·备货中」；供应商收到款项后开始备货'
              : '为该订单追加一条付款流水（不影响订单状态）'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 已有流水 */}
          {canViewList && (payData?.items?.length ?? 0) > 0 && (
            <div className="rounded-md border">
              <div className="flex items-center justify-between border-b bg-muted/40 px-2.5 py-1.5 text-xs">
                <span className="font-medium">已登记流水（{payData!.items.length}）</span>
                <span className="font-mono">
                  合计 {fmtMoney(payData!.paidAmount)}
                </span>
              </div>
              <ul className="divide-y text-xs">
                {payData!.items.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {PAYMENT_TYPE_LABEL[p.type] ?? p.type}
                    </Badge>
                    <span className="font-mono">{fmtMoney(p.amount)}</span>
                    <span className="text-muted-foreground">{fmtDate(p.paidAt)}</span>
                    {p.voucherNo && (
                      <span className="truncate text-muted-foreground">凭证 {p.voucherNo}</span>
                    )}
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {p.createdBy?.name ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>付款类型 *</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>金额（元）*</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>付款日期 *</Label>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>付款方式</Label>
              <Input
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="如 对公转账/承兑"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>凭证号</Label>
            <Input
              value={voucherNo}
              onChange={(e) => setVoucherNo(e.target.value)}
              placeholder="银行流水号/回单编号（可选）"
            />
          </div>
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Input
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="可选"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className={cn(advanceMode && 'bg-emerald-600 hover:bg-emerald-700')}
          >
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {advanceMode ? '登记付款并推进' : '登记流水'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
