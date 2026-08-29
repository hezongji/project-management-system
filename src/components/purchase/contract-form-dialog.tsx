'use client'

/**
 * 合同登记/确认弹窗（★ V3 P0 2026-08-22，工作流第④⑤步）
 *
 * mode='start'   发起合同（DRAFT→CONTRACT_PENDING，创建/更新合同 PENDING）
 * mode='confirm' 确认合同与价格（CONTRACT_PENDING→CONFIRMED，合同置 CONFIRMED+留痕）
 * 提交走统一推进 API：PATCH /api/purchase-orders/[id]/advance { action, contract }
 */

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, FileSignature } from 'lucide-react'
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

export interface ContractFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  orderCode: string
  /** 订单金额（预填合同金额） */
  orderAmount?: number | null
  /** start=发起合同；confirm=确认合同与价格 */
  mode: 'start' | 'confirm'
  /** 已有合同（confirm 时回显） */
  existing?: {
    contractNo?: string | null
    supplierContractNo?: string | null
    contractAmount?: number | null
    deliveryTerms?: string | null
    paymentTerms?: string | null
  } | null
  onSaved?: () => void
}

export function ContractFormDialog({
  open,
  onOpenChange,
  orderId,
  orderCode,
  orderAmount,
  mode,
  existing,
  onSaved,
}: ContractFormDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  const [contractNo, setContractNo] = React.useState('')
  const [supplierContractNo, setSupplierContractNo] = React.useState('')
  const [contractAmount, setContractAmount] = React.useState('')
  const [deliveryTerms, setDeliveryTerms] = React.useState('')
  const [paymentTerms, setPaymentTerms] = React.useState('')
  const [remark, setRemark] = React.useState('')

  React.useEffect(() => {
    if (open) {
      setContractNo(existing?.contractNo ?? orderCode)
      setSupplierContractNo(existing?.supplierContractNo ?? '')
      setContractAmount(
        existing?.contractAmount != null
          ? String(existing.contractAmount)
          : orderAmount != null
            ? String(orderAmount)
            : '',
      )
      setDeliveryTerms(existing?.deliveryTerms ?? '')
      setPaymentTerms(existing?.paymentTerms ?? '')
      setRemark('')
    }
  }, [open, existing, orderCode, orderAmount])

  const submit = async () => {
    if (saving) return
    if (!contractNo.trim()) {
      toast({ variant: 'destructive', description: '请填写合同编号' })
      return
    }
    setSaving(true)
    try {
      const amount = contractAmount.trim() === '' ? undefined : Number(contractAmount)
      await ApiService.patch(`/purchase-orders/${orderId}/advance`, {
        action: mode === 'start' ? 'START_CONTRACT' : 'CONFIRM_CONTRACT',
        contract: {
          contractNo: contractNo.trim() || undefined,
          ...(supplierContractNo.trim() && { supplierContractNo: supplierContractNo.trim() }),
          ...(amount != null && Number.isFinite(amount) && amount >= 0 && { contractAmount: amount }),
          ...(deliveryTerms.trim() && { deliveryTerms: deliveryTerms.trim() }),
          ...(paymentTerms.trim() && { paymentTerms: paymentTerms.trim() }),
        },
        ...(remark.trim() && { remark: remark.trim() }),
      })
      toast({
        description:
          mode === 'start'
            ? '合同已登记，等待供应商确认合同（待合同 → 合同确认）✓'
            : '合同已确认，可正式下单 ✓',
      })
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-order', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-contract', orderId] })
      queryClient.invalidateQueries({ queryKey: ['purchase-summary'] })
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '操作失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSignature className="h-4 w-4 text-primary" />
            {mode === 'start' ? '发起合同' : '确认合同与价格'} · {orderCode}
          </DialogTitle>
          <DialogDescription>
            {mode === 'start'
              ? '登记供应商提供的合同要素；登记后状态推进为「待合同」，供应商确认后再「确认合同」'
              : '核对合同编号/金额/交期条款无误后确认；确认后合同不可再编辑，可正式下单'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>合同编号 *</Label>
              <Input
                value={contractNo}
                onChange={(e) => setContractNo(e.target.value)}
                placeholder="如 HT-DEMO26034-001"
              />
            </div>
            <div className="space-y-1.5">
              <Label>供应商合同号</Label>
              <Input
                value={supplierContractNo}
                onChange={(e) => setSupplierContractNo(e.target.value)}
                placeholder="供应商自己的编号（可选）"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>合同金额（元）</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={contractAmount}
                onChange={(e) => setContractAmount(e.target.value)}
                placeholder="默认取订单金额"
              />
            </div>
            <div className="space-y-1.5">
              <Label>交货期条款</Label>
              <Input
                value={deliveryTerms}
                onChange={(e) => setDeliveryTerms(e.target.value)}
                placeholder="如 收款后 15 个工作日"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>付款条款</Label>
            <Input
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              placeholder="如 预付 30%，到货验收后付尾款"
            />
          </div>
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              className="min-h-16"
              placeholder="可选"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {mode === 'start' ? '登记合同' : '确认合同'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
