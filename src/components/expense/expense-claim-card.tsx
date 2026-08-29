'use client'

/**
 * 费用报销卡片（F3-R2 报销单+明细重构）—— 挂在项目详情页
 *
 * 顶部：审批流程说明条（报销人提交 → 管理员审批 → 财务打款）
 *      + 报销总额统计 + 状态徽章（草稿/审批中/待打款/已打款/已驳回计数）+ 新增报销单按钮
 * 列表：报销单号/报销人/明细数/总额/状态/审批人/打款人/提交时间/操作
 * 操作（按状态+角色显隐，后端终审）：
 *   DRAFT     + 报销人 → 提交 / 编辑 / 删除
 *   SUBMITTED + ADMIN  → 审批 / 驳回（必填原因）
 *   APPROVED  + 财务部 → 打款
 *   REJECTED  + 报销人 → 重新编辑
 *   全部行 → 详情（明细表 + 审批时间线）
 *
 * ★ 可见性：列表/统计仅含当前用户可见报销单（报销人本人 ∪ 财务部 ∪ ADMIN，后端过滤）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Wallet,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  Check,
  X,
  Banknote,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  UserCheck,
  Coins,
  ArrowRight,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { cn } from '@/lib/utils'
import {
  ExpenseClaimFormDialog,
  type ExpenseClaim,
  type ExpenseClaimStatus,
  CLAIM_STATUS_CLS,
  CLAIM_STATUS_TEXT,
  claimNo,
  claimSubmittedAt,
  fmtClaimAmount,
  fmtClaimDateTime,
} from './expense-claim-form-dialog'
import { ExpenseClaimDetailDialog } from './expense-claim-detail-dialog'

// ───────────────────────────── 类型 ─────────────────────────────

/** 当前用户快照（详情页 /auth/me 已含 department） */
export interface ExpenseClaimViewer {
  id: string
  role: string
  department?: { id: string; name: string } | null
}

interface SummaryResult {
  project: { id: string; code: string; name: string }
  total: { count: number; amount: number }
  byStatus: Array<{ status: ExpenseClaimStatus; count: number; amount: number }>
}

const PAGE_SIZE = 20

export interface ExpenseClaimCardProps {
  projectId: string
  /** 我在该项目的角色（null = 非项目成员，如财务/ADMIN 直访） */
  myRole?: string | null
  me?: ExpenseClaimViewer | null
}

export function ExpenseClaimCard({ projectId, myRole, me }: ExpenseClaimCardProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const isAdmin = me?.role === 'ADMIN'
  // 与后端 isFinanceDept 同口径：部门名含「财务」
  const isFinance = !!me?.department?.name?.includes('财务')
  const isSubmitterOf = (c: ExpenseClaim) =>
    !!me && (me.id === c.payeeId || me.id === c.createdById)

  // ── 报销单列表（分页，含明细+审批人+打款人） ──
  const [page, setPage] = React.useState(1)
  const { data: listData, isLoading } = useQuery({
    queryKey: ['project-expense-claims', projectId, page],
    queryFn: () =>
      ApiService.get<{
        items: ExpenseClaim[]
        pagination: { page: number; pages: number; total: number }
      }>(`/projects/${projectId}/expense-claims`, { page, limit: PAGE_SIZE }).then((r) => r.data),
    enabled: !!projectId,
  })
  const claims = listData?.items ?? []
  const pagination = listData?.pagination

  // ── 统计 ──
  const { data: summary } = useQuery({
    queryKey: ['project-expense-claims-summary', projectId],
    queryFn: () =>
      ApiService.get<SummaryResult>(`/projects/${projectId}/expense-claims/summary`).then(
        (r) => r.data,
      ),
    enabled: !!projectId,
  })

  // ── 弹窗状态 ──
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ExpenseClaim | null>(null)
  const [viewing, setViewing] = React.useState<ExpenseClaim | null>(null)
  const [deleting, setDeleting] = React.useState<ExpenseClaim | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const [rejecting, setRejecting] = React.useState<ExpenseClaim | null>(null)
  const [rejectReason, setRejectReason] = React.useState('')
  const [rejectBusy, setRejectBusy] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['project-expense-claims', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-expense-claims-summary', projectId] })
  }

  // 状态流转：submit / approve / pay / reedit
  const doAction = async (
    c: ExpenseClaim,
    action: 'submit' | 'approve' | 'pay' | 'reedit',
  ) => {
    setBusyId(c.id)
    try {
      await ApiService.patch(`/expense-claims/${c.id}`, { action })
      const text: Record<string, string> = {
        submit: '报销单已提交审批',
        approve: '已审批通过（待财务打款）',
        pay: '已标记打款 ✓',
        reedit: '已退回草稿，可编辑明细后重新提交',
      }
      toast({ description: text[action] })
      refresh()
    } catch (err) {
      toast({
        variant: 'destructive',
        description: err instanceof Error ? err.message : '操作失败',
      })
    } finally {
      setBusyId(null)
    }
  }

  const doReject = async () => {
    if (!rejecting) return
    if (!rejectReason.trim()) {
      toast({ variant: 'destructive', description: '驳回必须填写原因' })
      return
    }
    setRejectBusy(true)
    try {
      await ApiService.patch(`/expense-claims/${rejecting.id}`, {
        action: 'reject',
        rejectedReason: rejectReason.trim(),
      })
      toast({ description: '已驳回，报销人可重新编辑后再提交' })
      setRejecting(null)
      setRejectReason('')
      refresh()
    } catch (err) {
      toast({
        variant: 'destructive',
        description: err instanceof Error ? err.message : '驳回失败',
      })
    } finally {
      setRejectBusy(false)
    }
  }

  const doDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await ApiService.delete(`/expense-claims/${deleting.id}`)
      toast({ description: '报销单草稿已删除' })
      setDeleting(null)
      refresh()
    } catch (err) {
      toast({
        variant: 'destructive',
        description: err instanceof Error ? err.message : '删除失败',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (c: ExpenseClaim) => {
    setEditing(c)
    setFormOpen(true)
  }

  const statusCount = (s: ExpenseClaimStatus) =>
    summary?.byStatus.find((x) => x.status === s)?.count ?? 0

  const canCreate = isAdmin || isFinance || myRole != null

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {/* ── 头部：标题 + 流程说明 + 新增 ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">费用报销</h2>
            <BadgeCount n={summary?.total.count ?? 0} />
          </div>
          {canCreate && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新增报销单
            </Button>
          )}
        </div>

        {/* ── 审批流程说明条 ── */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm">
          <span className="font-medium text-primary">报销流程：</span>
          <span className="inline-flex items-center gap-1">
            <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
            报销人提交
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            管理员审批
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="inline-flex items-center gap-1">
            <Coins className="h-3.5 w-3.5 text-muted-foreground" />
            财务打款
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            驳回后可重新编辑再提交
          </span>
        </div>

        {/* ── 统计条：总额 + 状态徽章 ── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-4 py-3">
          <div>
            <p className="text-xs text-muted-foreground">报销总额（可见口径）</p>
            <p className="font-mono text-lg font-semibold">
              {fmtClaimAmount(summary ? summary.total.amount : null)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED'] as ExpenseClaimStatus[]
            ).map((s) => {
              const n = statusCount(s)
              if (n === 0) return null
              return (
                <span
                  key={s}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-xs font-medium',
                    CLAIM_STATUS_CLS[s],
                  )}
                >
                  {CLAIM_STATUS_TEXT[s]} {n}
                </span>
              )
            })}
            {summary && summary.total.count === 0 && (
              <span className="text-xs text-muted-foreground">暂无报销单</span>
            )}
          </div>
        </div>

        {/* ── 报销单列表 ── */}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载报销单…
          </div>
        ) : claims.length === 0 ? (
          <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
            暂无报销单
            {!isAdmin && !isFinance && (
              <span className="mt-1 block text-xs">
                仅显示你本人提交的报销单；财务部与管理员可见全部
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">报销单号</th>
                    <th className="px-3 py-2 font-medium">报销人</th>
                    <th className="px-3 py-2 text-center font-medium">明细数</th>
                    <th className="px-3 py-2 text-right font-medium">总额</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">审批人</th>
                    <th className="px-3 py-2 font-medium">打款人</th>
                    <th className="px-3 py-2 font-medium">提交时间</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => {
                    const busy = busyId === c.id
                    return (
                      <tr key={c.id} className="border-t align-top hover:bg-muted/20">
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <button
                            type="button"
                            className="font-mono text-xs font-semibold text-primary hover:underline"
                            title={c.id}
                            onClick={() => setViewing(c)}
                          >
                            {claimNo(c.id)}
                          </button>
                          {c.remark && (
                            <p className="mt-0.5 max-w-[140px] truncate text-[11px] text-muted-foreground" title={c.remark}>
                              {c.remark}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">{c.payee?.name ?? '—'}</td>
                        <td className="px-3 py-2.5 text-center">{c.items.length}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono font-medium">
                          {fmtClaimAmount(c.totalAmount)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-xs font-semibold',
                              CLAIM_STATUS_CLS[c.status],
                            )}
                          >
                            {CLAIM_STATUS_TEXT[c.status]}
                          </span>
                          {c.status === 'REJECTED' && c.rejectedReason && (
                            <p
                              className="mt-0.5 max-w-[140px] truncate text-[11px] text-red-600"
                              title={c.rejectedReason}
                            >
                              原因：{c.rejectedReason}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {c.approvedBy?.name ?? '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">{c.paidBy?.name ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                          {claimSubmittedAt(c) ? fmtClaimDateTime(claimSubmittedAt(c)) : '未提交'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {/* DRAFT + 报销人：提交/编辑/删除 */}
                            {c.status === 'DRAFT' && isSubmitterOf(c) && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={busy}
                                  onClick={() => doAction(c, 'submit')}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Check className="h-3 w-3" />
                                  )}
                                  提交
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={busy}
                                  onClick={() => openEdit(c)}
                                  title="编辑报销单与明细"
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                  disabled={busy}
                                  onClick={() => setDeleting(c)}
                                  title="删除草稿"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                            {/* SUBMITTED + ADMIN：审批/驳回 */}
                            {c.status === 'SUBMITTED' && isAdmin && (
                              <>
                                <Button
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={busy}
                                  onClick={() => doAction(c, 'approve')}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Check className="h-3 w-3" />
                                  )}
                                  审批
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                                  disabled={busy}
                                  onClick={() => {
                                    setRejecting(c)
                                    setRejectReason('')
                                  }}
                                >
                                  <X className="h-3 w-3" />
                                  驳回
                                </Button>
                              </>
                            )}
                            {/* APPROVED + 财务部：打款 */}
                            {c.status === 'APPROVED' && isFinance && (
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={busy}
                                onClick={() => doAction(c, 'pay')}
                              >
                                {busy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Banknote className="h-3 w-3" />
                                )}
                                打款
                              </Button>
                            )}
                            {/* REJECTED + 报销人：重新编辑 */}
                            {c.status === 'REJECTED' && isSubmitterOf(c) && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={busy}
                                onClick={() => doAction(c, 'reedit')}
                                title="退回草稿后可编辑明细再提交"
                              >
                                <RotateCcw className="h-3 w-3" />
                                重新编辑
                              </Button>
                            )}
                            {/* 全部行：详情 */}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => setViewing(c)}
                              title="查看明细与审批时间线"
                            >
                              <Eye className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* 分页 */}
            {pagination && pagination.pages > 1 && (
              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span>
                  第 {pagination.page} / {pagination.pages} 页 · 共 {pagination.total} 张
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={page >= pagination.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* 新增/编辑报销单弹窗 */}
      <ExpenseClaimFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        projectId={projectId}
        editClaim={editing}
        me={me ? { id: me.id } : null}
        onSaved={refresh}
      />

      {/* 报销单详情弹窗（明细表+审批时间线） */}
      <ExpenseClaimDetailDialog
        open={viewing !== null}
        onOpenChange={(v) => !v && setViewing(null)}
        claim={viewing}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="删除报销单草稿"
        description={`将永久删除报销单 ${claimNo(deleting?.id ?? '')}（${
          deleting?.items.length ?? 0
        } 条明细 · ${fmtClaimAmount(deleting?.totalAmount ?? null)}），该操作不可恢复。`}
        confirmText="删除"
        destructive
        loading={deleteBusy}
        onConfirm={doDelete}
      />

      {/* 驳回原因弹窗 */}
      <Dialog open={rejecting !== null} onOpenChange={(v) => !v && setRejecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>驳回报销单</DialogTitle>
            <DialogDescription>
              报销单 {claimNo(rejecting?.id ?? '')} · {rejecting?.items.length ?? 0} 条明细 ·{' '}
              {fmtClaimAmount(rejecting?.totalAmount ?? null)} · 报销人{' '}
              {rejecting?.payee?.name ?? '—'}，驳回后可重新编辑再提交
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="reject-reason">
              驳回原因 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="reject-reason"
              maxLength={500}
              placeholder="如：发票附件不全 / 金额与申请不符"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={rejectBusy}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={doReject}
              disabled={rejectBusy || rejectReason.trim() === ''}
            >
              {rejectBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** 计数小徽章 */
function BadgeCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-normal text-secondary-foreground">
      {n} 张
    </span>
  )
}
