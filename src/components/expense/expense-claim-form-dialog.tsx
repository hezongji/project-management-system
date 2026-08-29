'use client'

/**
 * 报销单 新建/编辑 弹窗（F3-R2 报销单+明细重构）
 *
 * 报销单基础：报销人（默认本人，只读）+ 备注（可选）
 * 费用明细动态列表：每行 = 分类下拉 / 金额 / 日期 / 说明，可增删行，至少 1 行
 * 保存即一次性创建/更新 报销单+全部明细：
 *   新建  POST /api/projects/:id/expense-claims { remark, items }
 *   编辑  PATCH /api/expense-claims/:id { remark, items }（items 全量：带 id=更新、
 *         不带 id=新增、缺失 id=删除，总额由后端 Decimal 重算）
 *
 * 本文件同时导出报销单共享类型与状态映射（卡片/详情弹窗复用）。
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Loader2, Trash2, Wallet } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { cn } from '@/lib/utils'

// ───────────────────────────── 共享类型（卡片/详情弹窗复用） ─────────────────────────────

export type ExpenseClaimStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PAID' | 'REJECTED'

/** 费用明细行（挂在报销单下） */
export interface ExpenseClaimItem {
  id: string
  claimId: string
  categoryId: string
  amount: number
  expenseDate: string
  description: string | null
  category: { id: string; name: string; code: string }
}

/** 报销单（GET 列表/详情、POST/PATCH 返回同构） */
export interface ExpenseClaim {
  id: string
  projectId: string
  payeeId: string
  createdById: string
  status: ExpenseClaimStatus
  totalAmount: number
  rejectedReason: string | null
  approvedById: string | null
  approvedAt: string | null
  paidById: string | null
  paidAt: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
  /** 后端暂未落库该字段，提交时间以 createdAt 近似；后端补字段后自动生效 */
  submittedAt?: string | null
  items: ExpenseClaimItem[]
  payee: { id: string; name: string }
  createdBy: { id: string; name: string }
  approvedBy: { id: string; name: string } | null
  paidBy: { id: string; name: string } | null
}

/** 费用分类（GET /api/expense-categories） */
export interface ExpenseCategory {
  id: string
  name: string
  code: string
  sort: number
  isSystem: boolean
  isActive: boolean
}

export const CLAIM_STATUS_TEXT: Record<ExpenseClaimStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '审批中',
  APPROVED: '待打款',
  PAID: '已打款',
  REJECTED: '已驳回',
}

export const CLAIM_STATUS_CLS: Record<ExpenseClaimStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  APPROVED: 'bg-amber-100 text-amber-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-600',
}

/** 金额格式化（与旧费用模块口径一致） */
export const fmtClaimAmount = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 日期格式化（yyyy-MM-dd） */
export const fmtClaimDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—'

/** 日期时间格式化（审批时间线用） */
export const fmtClaimDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

/** 报销单号展示（取 id 前 8 位） */
export const claimNo = (id: string) => id.slice(0, 8).toUpperCase()

/** 报销单显示用提交时间（后端暂无 submittedAt，以创建时间近似；DRAFT=未提交） */
export const claimSubmittedAt = (c: ExpenseClaim): string | null =>
  c.status === 'DRAFT' ? null : (c.submittedAt ?? c.createdAt)

// ───────────────────────────── 表单内部类型 ─────────────────────────────

/** 本地明细行（编辑时携带服务端 id → PATCH 全量同步） */
interface ItemRow {
  key: string
  categoryId: string
  amount: string
  expenseDate: string
  description: string
  /** 编辑已有明细时携带 */
  id?: string
}

export interface ExpenseClaimFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** 编辑目标（null=新建）；仅 DRAFT 可编辑 */
  editClaim: ExpenseClaim | null
  /** 当前用户（报销人默认本人，只读展示） */
  me: { id: string; name?: string } | null
  onSaved?: () => void
}

let rowSeq = 0
const newRow = (): ItemRow => ({
  key: `row-${Date.now()}-${rowSeq++}`,
  categoryId: '',
  amount: '',
  expenseDate: '',
  description: '',
})

/** 今日 yyyy-MM-dd（新行默认日期） */
const today = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function ExpenseClaimFormDialog({
  open,
  onOpenChange,
  projectId,
  editClaim,
  me,
  onSaved,
}: ExpenseClaimFormDialogProps) {
  const { toast } = useToast()
  const [remark, setRemark] = React.useState('')
  const [rows, setRows] = React.useState<ItemRow[]>([])
  const [saving, setSaving] = React.useState(false)
  /** 已触发行的错误标记（保存时校验填充） */
  const [touched, setTouched] = React.useState(false)

  // 分类下拉（仅启用中的分类）
  const { data: categories } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => ApiService.get<ExpenseCategory[]>('/expense-categories').then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  })

  // 打开时初始化：新建=1 空行；编辑=载入已有明细
  React.useEffect(() => {
    if (!open) return
    setTouched(false)
    if (editClaim) {
      setRemark(editClaim.remark ?? '')
      setRows(
        editClaim.items.map((it) => ({
          key: `row-${it.id}`,
          id: it.id,
          categoryId: it.categoryId,
          amount: String(it.amount),
          // Date → yyyy-MM-dd（取本地时区）
          expenseDate: new Date(it.expenseDate).toLocaleDateString('sv-SE'),
          description: it.description ?? '',
        })),
      )
    } else {
      setRemark('')
      setRows([{ ...newRow(), expenseDate: today() }])
    }
  }, [open, editClaim])

  const setRow = (key: string, patch: Partial<ItemRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, { ...newRow(), expenseDate: today() }])
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key))

  // 合计（编辑框实时计算）
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  // 校验：至少 1 行；每行 分类必选 / 金额>0 / 日期必填
  const validate = (): string | null => {
    if (rows.length === 0) return '至少需要一条费用明细'
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (!r.categoryId) return `第 ${i + 1} 条明细未选择费用分类`
      const amt = Number(r.amount)
      if (!r.amount || Number.isNaN(amt) || amt <= 0) return `第 ${i + 1} 条明细金额必须大于 0`
      if (!r.expenseDate) return `第 ${i + 1} 条明细未填写费用日期`
    }
    return null
  }

  const handleSave = async () => {
    setTouched(true)
    const err = validate()
    if (err) {
      toast({ variant: 'destructive', description: err })
      return
    }
    setSaving(true)
    try {
      const payload = {
        remark: remark.trim() || null,
        items: rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          categoryId: r.categoryId,
          amount: Number(r.amount),
          expenseDate: r.expenseDate,
          description: r.description.trim() || null,
        })),
      }
      if (editClaim) {
        await ApiService.patch(`/expense-claims/${editClaim.id}`, payload)
        toast({ description: '报销单已保存（明细与总额已同步更新）' })
      } else {
        await ApiService.post(`/projects/${projectId}/expense-claims`, payload)
        toast({ description: '报销单草稿已保存，可提交审批' })
      }
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast({
        variant: 'destructive',
        title: '保存失败',
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSaving(false)
    }
  }

  const rowInvalid = (r: ItemRow) =>
    touched && (!r.categoryId || !r.amount || Number.isNaN(Number(r.amount)) || Number(r.amount) <= 0 || !r.expenseDate)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Wallet className="h-4 w-4 text-primary" />
            {editClaim ? `编辑报销单 ${claimNo(editClaim.id)}` : '新增报销单'}
          </DialogTitle>
          <DialogDescription>
            {editClaim
              ? '修改备注或费用明细（明细全量同步：新增行=新增明细，删除行=删除明细），总额自动重算'
              : '报销人默认为本人；填写费用明细（至少 1 条），保存后为草稿，提交后进入审批流'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* ── 报销单基础 ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>报销人</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
                {me?.name || '当前登录用户'}
                <span className="ml-2 text-xs text-muted-foreground">（默认本人）</span>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="claim-remark">备注（可选）</Label>
              <Input
                id="claim-remark"
                maxLength={500}
                placeholder="如：3 月出差上海项目现场费用"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
          </div>

          {/* ── 费用明细动态列表 ── */}
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>
                费用明细 <span className="text-destructive">*</span>
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {rows.length} 条 · 至少 1 条
                </span>
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={rows.length >= 100}
                onClick={addRow}
              >
                <Plus className="mr-0.5 h-3 w-3" />
                加一条
              </Button>
            </div>

            <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-0.5">
              {rows.map((r, i) => {
                const bad = rowInvalid(r)
                return (
                  <div
                    key={r.key}
                    className={cn(
                      'grid grid-cols-1 items-start gap-2 rounded-lg border p-2.5 sm:grid-cols-[1.3fr_0.8fr_0.9fr_1.4fr_auto]',
                      bad && 'border-destructive/50',
                    )}
                  >
                    {/* 序号 + 分类 */}
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">第 {i + 1} 条</span>
                      <Select value={r.categoryId} onValueChange={(v) => setRow(r.key, { categoryId: v })}>
                        <SelectTrigger className="h-8 w-full text-sm">
                          <SelectValue placeholder="选择费用分类" />
                        </SelectTrigger>
                        <SelectContent>
                          {(categories ?? []).map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* 金额 */}
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">金额（元）</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        className="h-8 text-sm"
                        placeholder="0.00"
                        value={r.amount}
                        onChange={(e) => setRow(r.key, { amount: e.target.value })}
                      />
                    </div>
                    {/* 日期 */}
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">费用日期</span>
                      <Input
                        type="date"
                        className="h-8 text-sm"
                        value={r.expenseDate}
                        onChange={(e) => setRow(r.key, { expenseDate: e.target.value })}
                      />
                    </div>
                    {/* 说明 */}
                    <div className="grid gap-1">
                      <span className="text-[11px] text-muted-foreground">说明（可选）</span>
                      <Input
                        className="h-8 text-sm"
                        maxLength={500}
                        placeholder="如：上海-苏州高铁票"
                        value={r.description}
                        onChange={(e) => setRow(r.key, { description: e.target.value })}
                      />
                    </div>
                    {/* 删除行 */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive sm:mt-5"
                      disabled={rows.length <= 1}
                      title={rows.length <= 1 ? '至少保留 1 条明细' : '删除该条明细'}
                      onClick={() => removeRow(r.key)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
              {rows.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  暂无明细，点击「加一条」新增
                </p>
              )}
            </div>
          </div>

          {/* ── 合计 + 备注 ── */}
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-2.5">
            <span className="text-sm text-muted-foreground">
              报销合计（{rows.length} 条明细）
              {editClaim?.rejectedReason && (
                <span className="ml-2 text-xs text-red-600" title={editClaim.rejectedReason}>
                  驳回原因：{editClaim.rejectedReason}
                </span>
              )}
            </span>
            <span className="font-mono text-base font-semibold">{fmtClaimAmount(total)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || rows.length === 0}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editClaim ? '保存修改' : '保存草稿'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
