'use client'

/**
 * 到货登记 + 收货确认弹窗（★ V3 P0 2026-08-22，工作流第⑦⑧步）
 *
 * 一步完成：交货方式（发到公司/发到客户地址/自提）+ 客户地址 + 收货人指派 +
 * 明细清点（实到/破损/拒收）→ POST /api/purchase-orders/[id]/arrivals
 * 勾选「同时确认收货」→ POST /api/goods-arrivals/[id]/confirm（收货人留痕，全部到齐订单完成）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, PackageCheck, MapPin, UserRound } from 'lucide-react'
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResponsiveDialog, ResponsiveDialogContent } from '@/components/mobile/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'

const DELIVERY_TYPE_LABEL: Record<string, string> = {
  TO_COMPANY: '发到公司',
  TO_CUSTOMER: '发到客户地址',
  SELF_PICKUP: '自提',
}

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

interface MemberResp {
  members: Array<{ userId: string; name: string; jobTitle: string | null }>
}

export interface ArrivalConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  orderCode: string
  /** 项目成员（收货人下拉）；不传则不可选收货人（留空=订单指派人） */
  projectId?: string
  items: ArrivalRow[]
  /** 默认收货人（上次选择记忆） */
  defaultReceiverId?: string | null
  onSaved?: () => void
}

export function ArrivalConfirmDialog({
  open,
  onOpenChange,
  orderId,
  orderCode,
  projectId,
  items,
  onSaved,
}: ArrivalConfirmDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  const [batchNo, setBatchNo] = React.useState('')
  const [arrivalDate, setArrivalDate] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [deliveryType, setDeliveryType] = React.useState('TO_COMPANY')
  const [shippingAddress, setShippingAddress] = React.useState('')
  const [receiverId, setReceiverId] = React.useState('')
  const [proofNote, setProofNote] = React.useState('')
  const [autoConfirm, setAutoConfirm] = React.useState(true)
  const [remark, setRemark] = React.useState('')

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

  React.useEffect(() => {
    if (open) {
      setRows(initRows())
      setBatchNo('')
      setArrivalDate(new Date().toISOString().slice(0, 10))
      setDeliveryType('TO_COMPANY')
      setShippingAddress('')
      setReceiverId('')
      setProofNote('')
      setAutoConfirm(true)
      setRemark('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items])

  // 项目成员（收货人候选）
  const { data: memberData } = useQuery({
    queryKey: ['arrival-members', projectId],
    queryFn: () =>
      ApiService.get<MemberResp>(`/projects/${projectId}/members`).then((r) => r.data),
    enabled: open && !!projectId,
  })

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const submit = async () => {
    if (saving) return
    if (deliveryType === 'TO_CUSTOMER' && !shippingAddress.trim()) {
      toast({ variant: 'destructive', description: '发到客户地址时必须填写收货地址' })
      return
    }
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
      // ① 登记到货（含交货方式/地址/收货人）
      // 注：ApiService 已拆统一壳，res.data 即后端 data 字段（{ arrival, orderCompleted }）
      const res = await ApiService.post<{
        arrival?: { id: string }
        orderCompleted?: boolean
      }>(`/purchase-orders/${orderId}/arrivals`, {
        ...(batchNo.trim() && { batchNo: batchNo.trim() }),
        arrivalDate: new Date(arrivalDate).toISOString(),
        deliveryType,
        ...(deliveryType === 'TO_CUSTOMER' && shippingAddress.trim() && { shippingAddress: shippingAddress.trim() }),
        ...(receiverId && { receiverId }),
        remark: remark.trim() || null,
        items: payloadItems,
      })
      const arrivalId = res.data?.arrival?.id
      // ② 收货确认（留痕 + 全部到齐时订单完成）
      if (autoConfirm && arrivalId) {
        await ApiService.post(`/goods-arrivals/${arrivalId}/confirm`, {
          ...(proofNote.trim() && { proofNote: proofNote.trim() }),
        })
      }
      toast({
        description: autoConfirm
          ? '到货已登记并确认收货 ✓（收货人留痕，全部到齐订单自动完成）'
          : '到货已登记（待收货人确认）',
      })
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-summary'] })
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '登记失败' })
    } finally {
      setSaving(false)
    }
  }

  const members = memberData?.members ?? []

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-emerald-600" /> 到货清点 · {orderCode}
          </DialogTitle>
          <DialogDescription>
            登记交货方式与实收数量；确认收货后收货人留痕，全部到齐订单自动完成
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 基本信息 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>批次号</Label>
              <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="留空自动生成" />
            </div>
            <div className="space-y-1.5">
              <Label>到货日期 *</Label>
              <Input type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} />
            </div>
          </div>

          {/* 交货方式 + 地址 + 收货人 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" /> 交货方式 *
              </Label>
              <Select value={deliveryType} onValueChange={setDeliveryType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DELIVERY_TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <UserRound className="h-3.5 w-3.5 text-muted-foreground" /> 收货确认人
              </Label>
              <Select value={receiverId || 'none'} onValueChange={(v) => setReceiverId(v === 'none' ? '' : v)}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="留空=订单指派人" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">留空（订单指派人）</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.name}
                      {m.jobTitle ? ` · ${m.jobTitle}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {deliveryType === 'TO_CUSTOMER' && (
            <div className="space-y-1.5">
              <Label>客户收货地址 *</Label>
              <Input
                value={shippingAddress}
                onChange={(e) => setShippingAddress(e.target.value)}
                placeholder="客户/工地详细地址（发货到客户指定地址时必填）"
              />
            </div>
          )}

          {/* 明细清点 */}
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

          {/* 确认收货 + 凭证 */}
          <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={autoConfirm} onCheckedChange={(v) => setAutoConfirm(v === true)} />
              <span>同时确认收货（收货人留痕：{members.find((m) => m.userId === receiverId)?.name ?? '当前操作人'}）</span>
            </label>
            {autoConfirm && (
              <div className="space-y-1.5">
                <Label className="text-xs">签收凭证（送货单号/照片说明）</Label>
                <Input
                  value={proofNote}
                  onChange={(e) => setProofNote(e.target.value)}
                  placeholder="可选"
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>备注（缺件说明等）</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-1 h-4 w-4" />}
            提交{autoConfirm ? '并确认收货' : '清点'}
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
