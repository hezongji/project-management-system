'use client'

/**
 * 采购订单详情弹窗（★ V3 P0 2026-08-22 重构）
 *
 * 顶部：OrderStatusBar 状态标签链 + 下一步推进按钮
 * 区块：订单头 / 合同信息卡 / 付款流水卡（采购·财务可见） / 到货进度 / 明细表 / 收货记录（含确认）
 * 推进动作：发起合同/确认合同/正式下单/登记付款/登记发货/取消 → advance API；
 *          登记到货 → ArrivalConfirmDialog（登记+收货确认一步完成）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Plus, Truck, XCircle, FileSignature, Banknote, Pencil } from 'lucide-react'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuthStore } from '@/store/auth'
import {
  OrderStatusBar,
  PURCHASE_STATUS_LABEL,
  type PurchaseAdvanceAction,
} from './order-status-bar'
import { ContractFormDialog } from './contract-form-dialog'
import { PaymentFormDialog } from './payment-form-dialog'
import { ArrivalConfirmDialog, type ArrivalRow } from './arrival-confirm-dialog'

const ORDER_STATUS_BADGE: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  CONTRACT_PENDING: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  CONFIRMED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  ORDERED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  PREPARING: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  SHIPPED: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  PARTIAL: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  CANCELLED: 'bg-muted text-muted-foreground line-through',
}

const CATEGORY_LABEL: Record<string, string> = {
  MECHANICAL: '机械',
  ELECTRICAL: '电气',
  OTHER: '其他',
}

const CONTRACT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: '待采购确认', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  CONFIRMED: { label: '已确认', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  VOIDED: { label: '已作废', cls: 'bg-muted text-muted-foreground line-through' },
}

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  PREPAYMENT: '预付款',
  FULL: '全款',
  TAIL: '尾款',
  REFUND: '退款',
}

const ARRIVAL_STATUS_LABEL: Record<string, string> = {
  PENDING: '在途',
  RECEIVED: '已收货',
  PARTIAL: '部分',
  REJECTED: '拒收',
}

const DELIVERY_TYPE_LABEL: Record<string, string> = {
  TO_COMPANY: '发到公司',
  TO_CUSTOMER: '发到客户地址',
  SELF_PICKUP: '自提',
}

export interface OrderDetailDialogProps {
  orderId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 变更回调（列表刷新） */
  onChanged?: () => void
  /** 打开追加采购（由父组件处理，传项目 id） */
  onSupplement?: (orderId: string, projectId: string) => void
  /** 打开编辑（仅 DRAFT；由父组件处理） */
  onEdit?: (orderId: string) => void
}

interface OrderItem {
  id: string
  name: string
  spec: string | null
  brand: string | null
  unit: string
  quantity: number
  receivedQty: number
  unitPrice: number | null
}

interface ArrivalRecord {
  id: string
  batchNo: string
  arrivalDate: string
  status: string
  remark: string | null
  deliveryType: string | null
  shippingAddress: string | null
  receiverId: string | null
  confirmedAt: string | null
  proofNote: string | null
  createdBy: { name: string } | null
  items: Array<{ orderItemId: string; arrivedQty: number; defectQty: number; rejectQty: number }>
}

interface ContractInfo {
  id: string
  contractNo: string
  supplierContractNo: string | null
  contractAmount: number | null
  deliveryTerms: string | null
  paymentTerms: string | null
  status: string
  confirmedAt: string | null
  confirmedBy: { name: string } | null
}

interface PaymentRow {
  id: string
  type: string
  amount: number
  method: string | null
  voucherNo: string | null
  paidAt: string
  remark: string | null
  createdBy: { name: string } | null
}

interface OrderDetail {
  id: string
  code: string
  title: string
  category: string
  status: string
  isSupplementary: boolean
  supplementaryReason: string | null
  orderDate: string | null
  plannedArrivalDate: string | null
  shippedAt: string | null
  shippingNote: string | null
  amount: number | null
  settlementAmount: number | null
  paidAmount: number | null
  remark: string | null
  project: { id: string; code: string; name: string }
  supplier: { name: string } | null
  owner: { name: string } | null
  items: OrderItem[]
  arrivals: ArrivalRecord[]
  progress: { totalQty: number; receivedQty: number; itemsTotal: number; itemsDone: number; percent: number }
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—')

export function OrderDetailDialog({ orderId, open, onOpenChange, onChanged, onSupplement, onEdit }: OrderDetailDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const deptName = user?.department?.name ?? ''
  const isAdmin = user?.role === 'ADMIN'
  const isPurchase = isAdmin || deptName.includes('采购')
  const isFinance = deptName.includes('财务')

  // ── 弹窗状态 ──
  const [contractOpen, setContractOpen] = React.useState(false)
  const [contractMode, setContractMode] = React.useState<'start' | 'confirm'>('start')
  const [paymentOpen, setPaymentOpen] = React.useState(false)
  const [paymentAdvance, setPaymentAdvance] = React.useState(true)
  const [arrivalOpen, setArrivalOpen] = React.useState(false)
  const [placeOrderOpen, setPlaceOrderOpen] = React.useState(false)
  const [shipOpen, setShipOpen] = React.useState(false)
  const [shipNote, setShipNote] = React.useState('')
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [cancelReason, setCancelReason] = React.useState('')
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const [acting, setActing] = React.useState(false)

  // ── 数据 ──
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['purchase-order', orderId],
    queryFn: () =>
      ApiService.get<OrderDetail>(`/purchase-orders/${orderId}`).then((r) => r.data),
    enabled: open && !!orderId,
  })

  // 合同（所有人可见，金额由后端脱敏）
  const { data: contractData } = useQuery({
    queryKey: ['purchase-contract', orderId],
    queryFn: () =>
      ApiService.get<ContractInfo | null>(`/purchase-contracts?orderId=${orderId}`).then((r) => r.data),
    enabled: open && !!orderId,
  })

  // 付款流水（仅采购/财务/ADMIN；后端鉴权，无权限则 403 → 静默）
  const canViewPayments = isPurchase || isFinance || isAdmin
  const { data: payData } = useQuery({
    queryKey: ['purchase-payments', orderId],
    queryFn: () =>
      ApiService.get<{ items: PaymentRow[]; paidAmount: number }>(`/purchase-payments?orderId=${orderId}`)
        .then((r) => r.data)
        .catch(() => ({ items: [], paidAmount: 0 })),
    enabled: open && !!orderId && canViewPayments,
  })

  const order = data
  const contract = contractData ?? null
  const payments = payData?.items ?? []
  const paidAmount = payData?.paidAmount ?? Number(order?.paidAmount ?? 0)

  // ── 简单推进（正式下单/发货/取消）──
  const doSimpleAdvance = async (
    action: PurchaseAdvanceAction,
    extra?: Record<string, unknown>,
  ) => {
    if (!orderId) return
    setActing(true)
    try {
      const res = await ApiService.patch(`/purchase-orders/${orderId}/advance`, {
        action,
        ...extra,
      })
      toast({ description: res.message ?? '操作成功 ✓' })
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-summary'] })
      refetch()
      onChanged?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '操作失败' })
    } finally {
      setActing(false)
      setPlaceOrderOpen(false)
      setShipOpen(false)
      setCancelOpen(false)
      setShipNote('')
      setCancelReason('')
    }
  }

  const doConfirmArrival = async () => {
    if (!confirmingId) return
    setActing(true)
    try {
      await ApiService.post(`/goods-arrivals/${confirmingId}/confirm`, {})
      toast({ description: '收货确认成功 ✓' })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      refetch()
      onChanged?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '确认失败' })
    } finally {
      setActing(false)
      setConfirmingId(null)
    }
  }

  // ── 推进动作分发 ──
  const onAdvance = (action: PurchaseAdvanceAction) => {
    switch (action) {
      case 'START_CONTRACT':
        setContractMode('start')
        setContractOpen(true)
        break
      case 'CONFIRM_CONTRACT':
        setContractMode('confirm')
        setContractOpen(true)
        break
      case 'PLACE_ORDER':
        setPlaceOrderOpen(true)
        break
      case 'MARK_PREPARING':
        setPaymentAdvance(true)
        setPaymentOpen(true)
        break
      case 'MARK_SHIPPED':
        setShipOpen(true)
        break
      case 'CANCEL':
        setCancelOpen(true)
        break
    }
  }

  const statusLabel = order ? (PURCHASE_STATUS_LABEL[order.status] ?? order.status) : ''

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              采购订单 {order?.code ?? ''}
              {order && (
                <Badge className={cn('text-xs', ORDER_STATUS_BADGE[order.status] ?? '')}>
                  {statusLabel}
                </Badge>
              )}
              {order?.isSupplementary && (
                <Badge variant="destructive" className="text-xs">
                  追加
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {isLoading || !order ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* ★ 状态标签条（推进入口） */}
              <OrderStatusBar
                status={order.status}
                canOperate={isPurchase}
                canFinance={isFinance}
                onAdvance={onAdvance}
                onArrival={() => setArrivalOpen(true)}
                acting={acting}
              />

              {/* 订单头信息 */}
              <div className="grid gap-x-6 gap-y-1.5 rounded-md border p-3 text-sm sm:grid-cols-2">
                <Info label="标题" value={order.title} />
                <Info label="类别" value={CATEGORY_LABEL[order.category] ?? order.category} />
                <Info label="项目" value={`${order.project.code} · ${order.project.name}`} />
                <Info label="供应商" value={order.supplier?.name ?? '—'} />
                <Info label="下单日期" value={fmtDate(order.orderDate)} />
                <Info label="计划到货" value={fmtDate(order.plannedArrivalDate)} />
                {order.shippedAt && <Info label="发货日期" value={fmtDate(order.shippedAt)} />}
                {order.shippingNote && <Info label="物流备注" value={order.shippingNote} />}
                {canViewPayments && (
                  <Info
                    label="付款进度"
                    value={
                      order.amount != null
                        ? `${fmtMoney(paidAmount)} / ${fmtMoney(order.amount)}`
                        : fmtMoney(paidAmount)
                    }
                    mono
                  />
                )}
                <Info label="订单金额" value={fmtMoney(order.amount)} mono />
                <Info label="结算金额" value={fmtMoney(order.settlementAmount)} mono />
                {order.isSupplementary && order.supplementaryReason && (
                  <Info label="追加原因" value={order.supplementaryReason} />
                )}
                {order.remark && <Info label="备注" value={order.remark} />}
              </div>

              {/* ★ 合同信息卡 */}
              <div className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <FileSignature className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">合同</span>
                  {contract && CONTRACT_STATUS_LABEL[contract.status] && (
                    <Badge className={cn('text-xs', CONTRACT_STATUS_LABEL[contract.status].cls)}>
                      {CONTRACT_STATUS_LABEL[contract.status].label}
                    </Badge>
                  )}
                  {isPurchase && order.status === 'CONTRACT_PENDING' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 px-2 text-xs"
                      onClick={() => {
                        setContractMode('confirm')
                        setContractOpen(true)
                      }}
                    >
                      确认合同
                    </Button>
                  )}
                  {isPurchase && !contract && order.status === 'DRAFT' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 px-2 text-xs"
                      onClick={() => {
                        setContractMode('start')
                        setContractOpen(true)
                      }}
                    >
                      登记合同
                    </Button>
                  )}
                </div>
                {contract ? (
                  <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                    <Info label="合同编号" value={contract.contractNo} mono />
                    <Info label="供应商合同号" value={contract.supplierContractNo ?? '—'} mono />
                    <Info label="合同金额" value={fmtMoney(contract.contractAmount)} mono />
                    <Info label="交货期条款" value={contract.deliveryTerms ?? '—'} />
                    <Info label="付款条款" value={contract.paymentTerms ?? '—'} />
                    <Info
                      label="确认"
                      value={
                        contract.confirmedAt
                          ? `${contract.confirmedBy?.name ?? ''} · ${fmtDate(contract.confirmedAt)}`
                          : '待确认'
                      }
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    尚未登记合同；采购人员可在状态条「发起合同」处登记（工作流：供应商做合同 → 采购确认合同与价格 → 正式下单）
                  </p>
                )}
              </div>

              {/* ★ 付款流水卡（仅采购/财务可见） */}
              {canViewPayments && (
                <div className="rounded-md border p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Banknote className="h-4 w-4 text-amber-500" />
                    <span className="text-sm font-semibold">付款流水</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      已付 {fmtMoney(paidAmount)}
                      {order.amount != null && ` / ${fmtMoney(order.amount)}`}
                    </span>
                    {(isPurchase || isFinance || isAdmin) &&
                      order.status !== 'DRAFT' &&
                      order.status !== 'CANCELLED' &&
                      order.status !== 'COMPLETED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7 px-2 text-xs"
                          onClick={() => {
                            setPaymentAdvance(false)
                            setPaymentOpen(true)
                          }}
                        >
                          补登付款
                        </Button>
                      )}
                  </div>
                  {payments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      暂无付款记录；「已下单」状态点「登记付款·备货」推进流程（预付款/全款）
                    </p>
                  ) : (
                    <ul className="divide-y rounded-md border text-xs">
                      {payments.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {PAYMENT_TYPE_LABEL[p.type] ?? p.type}
                          </Badge>
                          <span className="font-mono">{fmtMoney(p.amount)}</span>
                          <span className="text-muted-foreground">{fmtDate(p.paidAt)}</span>
                          {p.method && <span className="text-muted-foreground">{p.method}</span>}
                          {p.voucherNo && (
                            <span className="text-muted-foreground">凭证 {p.voucherNo}</span>
                          )}
                          <span className="ml-auto text-muted-foreground">
                            {p.createdBy?.name ?? ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* 到货进度条 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    到货进度：{order.progress.itemsDone}/{order.progress.itemsTotal} 项到齐
                  </span>
                  <span className="font-mono">
                    {order.progress.receivedQty}/{order.progress.totalQty}（{order.progress.percent}%）
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.min(order.progress.percent, 100)}%` }}
                  />
                </div>
              </div>

              {/* 明细表 */}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">物料</th>
                      <th className="w-24 px-2 py-1.5 font-medium">品牌</th>
                      <th className="w-24 px-2 py-1.5 text-right font-medium">单价</th>
                      <th className="w-24 px-2 py-1.5 text-right font-medium">下单量</th>
                      <th className="w-24 px-2 py-1.5 text-right font-medium">已到货</th>
                      <th className="w-20 px-2 py-1.5 text-right font-medium">剩余</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((it) => {
                      const remain = Math.max(it.quantity - it.receivedQty, 0)
                      const done = remain === 0
                      return (
                        <tr key={it.id} className="border-t">
                          <td className="px-2 py-1.5">
                            <span className="font-medium">{it.name}</span>
                            {it.spec && <span className="ml-1 text-muted-foreground">{it.spec}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{it.brand ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(it.unitPrice)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {it.quantity} {it.unit}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                            {it.receivedQty}
                          </td>
                          <td className={cn('px-2 py-1.5 text-right font-mono', done && 'text-emerald-600 dark:text-emerald-400')}>
                            {done ? '✓' : remain}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* ★ 收货记录（含交货方式/地址/收货确认） */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  收货记录（{order.arrivals.length} 批）
                </p>
                {order.arrivals.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    暂无到货记录；「已发货」后点状态条「登记到货·收货」开始清点
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {order.arrivals.map((a) => (
                      <li key={a.id} className="rounded-md border p-2.5 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold">{a.batchNo}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {ARRIVAL_STATUS_LABEL[a.status] ?? a.status}
                          </Badge>
                          {a.deliveryType && (
                            <Badge variant="secondary" className="text-[10px]">
                              {DELIVERY_TYPE_LABEL[a.deliveryType] ?? a.deliveryType}
                            </Badge>
                          )}
                          <span className="text-muted-foreground">{fmtDate(a.arrivalDate)}</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            {a.confirmedAt ? (
                              <Badge className="bg-emerald-100 text-emerald-700 text-[10px] dark:bg-emerald-900/40 dark:text-emerald-300">
                                已确认收货
                              </Badge>
                            ) : (
                              <>
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  待收货确认
                                </Badge>
                                {(isPurchase || isAdmin) && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={acting}
                                    onClick={() => setConfirmingId(a.id)}
                                  >
                                    确认收货
                                  </Button>
                                )}
                              </>
                            )}
                          </span>
                        </div>
                        {a.shippingAddress && (
                          <p className="mt-1 text-muted-foreground">📦 收货地址：{a.shippingAddress}</p>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                          {a.items.map((ai) => {
                            const item = order.items.find((x) => x.id === ai.orderItemId)
                            return (
                              <span key={ai.orderItemId}>
                                {item?.name ?? '?'}：到 {ai.arrivedQty}
                                {ai.defectQty > 0 && ` · 破 ${ai.defectQty}`}
                                {ai.rejectQty > 0 && ` · 拒 ${ai.rejectQty}`}
                              </span>
                            )
                          })}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-muted-foreground">
                          <span>{a.createdBy?.name ?? ''} 登记</span>
                          {a.confirmedAt && <span>✓ 已于 {fmtDate(a.confirmedAt)} 确认</span>}
                          {a.proofNote && <span>凭证：{a.proofNote}</span>}
                        </div>
                        {a.remark && <p className="mt-1 text-muted-foreground">{a.remark}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}

          {/* 底部操作（保留：追加采购 + 登记到货快捷） */}
          {order && order.status !== 'CANCELLED' && order.status !== 'COMPLETED' && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
              {order.status === 'DRAFT' && onEdit && (
                <Button size="sm" variant="outline" onClick={() => onEdit(order.id)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> 编辑
                </Button>
              )}
              {(order.status === 'SHIPPED' || order.status === 'PARTIAL') && (
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => setArrivalOpen(true)}
                >
                  <Truck className="mr-1 h-3.5 w-3.5" /> 登记到货
                </Button>
              )}
              {onSupplement && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSupplement(order.id, order.project.id)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> 追加采购
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── 各操作弹窗 ── */}
      {order && (
        <>
          <ContractFormDialog
            open={contractOpen}
            onOpenChange={setContractOpen}
            orderId={order.id}
            orderCode={order.code}
            orderAmount={order.amount}
            mode={contractMode}
            existing={contract}
            onSaved={() => {
              refetch()
              onChanged?.()
            }}
          />
          <PaymentFormDialog
            open={paymentOpen}
            onOpenChange={setPaymentOpen}
            orderId={order.id}
            orderCode={order.code}
            advanceMode={paymentAdvance}
            canViewList={canViewPayments}
            onSaved={() => {
              refetch()
              onChanged?.()
            }}
          />
          <ArrivalConfirmDialog
            open={arrivalOpen}
            onOpenChange={setArrivalOpen}
            orderId={order.id}
            orderCode={order.code}
            projectId={order.project.id}
            items={order.items.map((it) => ({
              id: it.id,
              name: it.name,
              spec: it.spec,
              unit: it.unit,
              quantity: it.quantity,
              receivedQty: it.receivedQty,
            })) as ArrivalRow[]}
            onSaved={() => {
              refetch()
              onChanged?.()
            }}
          />
        </>
      )}

      {/* 正式下单确认 */}
      <ConfirmDialog
        open={placeOrderOpen}
        onOpenChange={setPlaceOrderOpen}
        title="确认正式下单？"
        description="合同已确认；下单后进入「已下单·待付款」，登记付款（预付款/全款）后供应商开始备货"
        confirmText="正式下单"
        loading={acting}
        onConfirm={() => doSimpleAdvance('PLACE_ORDER')}
      />

      {/* 发货登记 */}
      <Dialog open={shipOpen} onOpenChange={setShipOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-cyan-500" /> 登记发货
            </DialogTitle>
            <DialogDescription>
              供应商已收款备货并发货；登记后状态推进为「已发货」
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>快递单号 / 物流单号</Label>
              <Input value={shipNote} onChange={(e) => setShipNote(e.target.value)} placeholder="可选" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShipOpen(false)} disabled={acting}>
              取消
            </Button>
            <Button onClick={() => doSimpleAdvance('MARK_SHIPPED', { shippingNote: shipNote.trim() || undefined })} disabled={acting}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              确认发货
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 取消/作废 */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" /> 取消/作废订单
            </DialogTitle>
            <DialogDescription>订单将标记为已取消（合同同步作废），不可恢复</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>取消原因 *</Label>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="min-h-20"
                placeholder="如：供应商报价超预算 / 项目变更取消采购"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={acting}>
              返回
            </Button>
            <Button
              variant="destructive"
              disabled={acting || !cancelReason.trim()}
              onClick={() => doSimpleAdvance('CANCEL', { remark: cancelReason.trim() })}
            >
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              确认取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 收货确认（单批） */}
      <ConfirmDialog
        open={!!confirmingId}
        onOpenChange={(o) => !o && setConfirmingId(null)}
        title="确认收货？"
        description="确认后本批收货留痕（确认人+时间）；全部明细收齐时订单自动完成"
        confirmText="确认收货"
        loading={acting}
        onConfirm={doConfirmArrival}
      />
    </>
  )
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn('min-w-0 truncate text-foreground', mono && 'font-mono text-xs')}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}
