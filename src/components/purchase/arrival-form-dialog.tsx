'use client'

/**
 * 到货登记弹窗（2026-08-22 采购模块 Step 3）
 *
 * 显示订单全部明细，每行预填剩余未到货数量为默认实到，可改实到/破损/拒收；
 * 批次号默认自动生成（{订单号}-{序号}），提交 POST /api/purchase-orders/[id]/arrivals
 */

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, PackageCheck } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'

export interface ArrivalRow {
  id: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  receivedQty: number
}

interface RowState {
  arrivedQty: string
  defectQty: string
  rejectQty: string
}

export interface ArrivalFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  orderCode: string
  items: ArrivalRow[]
  /** 预填供应商（默认=订单供应商） */
  supplierId?: string | null
  onSaved?: () => void
}

export function ArrivalFormDialog({
  open,
  onOpenChange,
  orderId,
  orderCode,
  items,
  onSaved,
}: ArrivalFormDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)
  const [batchNo, setBatchNo] = React.useState('')
  const [arrivalDate, setArrivalDate] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  )
  const [remark, setRemark] = React.useState('')

  // 行状态：预填剩余数量
  const initRows = (): Record<string, RowState> =>
    Object.fromEntries(
      items.map((it) => [
        it.id,
        {
          arrivedQty: String(Math.max(it.quantity - it.receivedQty, 0)),
          defectQty: '',
          rejectQty: '',
        },
      ]),
    )
  const [rows, setRows] = React.useState<Record<string, RowState>>(() => initRows())

  // 打开时重置（items 变化后重新初始化）
  React.useEffect(() => {
    if (open) {
      setRows(initRows())
      setBatchNo('')
      setArrivalDate(new Date().toISOString().slice(0, 10))
      setRemark('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items])

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const submit = async () => {
    const payloadItems = items.map((it) => ({
      orderItemId: it.id,
      arrivedQty: Number(rows[it.id]?.arrivedQty ?? 0),
      ...(Number(rows[it.id]?.defectQty) > 0 && { defectQty: Number(rows[it.id].defectQty) }),
      ...(Number(rows[it.id]?.rejectQty) > 0 && { rejectQty: Number(rows[it.id].rejectQty) }),
    }))
    if (payloadItems.some((p) => Number.isNaN(p.arrivedQty) || p.arrivedQty < 0)) {
      toast({ variant: 'destructive', description: '实到数量不能为负' })
      return
    }
    if (payloadItems.every((p) => p.arrivedQty === 0)) {
      toast({ variant: 'destructive', description: '至少一行实到数量大于 0' })
      return
    }

    setSaving(true)
    try {
      await ApiService.post(`/purchase-orders/${orderId}/arrivals`, {
        ...(batchNo.trim() && { batchNo: batchNo.trim() }),
        arrivalDate: new Date(arrivalDate).toISOString(),
        status: 'RECEIVED',
        remark: remark.trim() || null,
        items: payloadItems,
      })
      toast({ description: '到货登记成功 ✓' })
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '登记失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-emerald-500" /> 到货清点 · {orderCode}
          </DialogTitle>
          <DialogDescription>
            每行已预填剩余未到货数量，请按实际收货调整；部分到货可分批多次登记
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>批次号</Label>
              <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="留空自动生成" />
            </div>
            <div className="space-y-1.5">
              <Label>到货日期 *</Label>
              <Input
                type="date"
                value={arrivalDate}
                onChange={(e) => setArrivalDate(e.target.value)}
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">物料</th>
                  <th className="w-16 px-2 py-1.5 text-right font-medium">下单</th>
                  <th className="w-16 px-2 py-1.5 text-right font-medium">已到</th>
                  <th className="w-24 px-2 py-1.5 font-medium">本次实到 *</th>
                  <th className="w-20 px-2 py-1.5 font-medium">破损</th>
                  <th className="w-20 px-2 py-1.5 font-medium">拒收</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-t">
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{it.name}</div>
                      {it.spec && <div className="text-muted-foreground">{it.spec}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {it.quantity} {it.unit}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                      {it.receivedQty}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <Input
                        className="h-7 text-xs"
                        type="number"
                        min="0"
                        step="any"
                        value={rows[it.id]?.arrivedQty ?? ''}
                        onChange={(e) => setRow(it.id, { arrivedQty: e.target.value })}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <Input
                        className="h-7 text-xs"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        value={rows[it.id]?.defectQty ?? ''}
                        onChange={(e) => setRow(it.id, { defectQty: e.target.value })}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <Input
                        className="h-7 text-xs"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        value={rows[it.id]?.rejectQty ?? ''}
                        onChange={(e) => setRow(it.id, { rejectQty: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <Label>备注（缺件说明等）</Label>
            <Textarea value={remark} onChange={(e) => setRemark(e.target.value)} className="min-h-16" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-1 h-4 w-4" />}
            提交清点
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
