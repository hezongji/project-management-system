'use client'

/**
 * 报销单详情弹窗（F3-R2 报销单+明细重构）
 *
 * 内容：报销单头部（单号/状态/报销人/总额/备注）+ 完整费用明细表
 *      （分类/金额/日期/说明，逐条可见）+ 竖向审批时间线
 * 时间线：创建（报销人+时间）→ 提交审批（报销人）→ 审批（审批人+时间 / 驳回+原因）
 *        → 打款（打款人+时间）——谁在何时做了什么一目了然
 */

import { Circle, CheckCircle2, CircleDashed, XCircle, Clock3 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  type ExpenseClaim,
  CLAIM_STATUS_CLS,
  CLAIM_STATUS_TEXT,
  claimNo,
  claimSubmittedAt,
  fmtClaimAmount,
  fmtClaimDate,
  fmtClaimDateTime,
} from './expense-claim-form-dialog'

export interface ExpenseClaimDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 列表行数据（含 items/审批人/打款人，与详情接口同构） */
  claim: ExpenseClaim | null
}

/** 时间线节点 */
interface TimelineNode {
  key: string
  icon: React.ReactNode
  title: string
  /** 谁 + 何时做了什么 */
  actor?: string | null
  time?: string | null
  detail?: string | null
  tone: 'neutral' | 'done' | 'current' | 'danger' | 'pending'
}

const TONE_CLS: Record<TimelineNode['tone'], string> = {
  neutral: 'border-border bg-muted/50 text-muted-foreground',
  done: 'border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400',
  current: 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-400',
  danger: 'border-red-300 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400',
  pending: 'border-dashed text-muted-foreground',
}

/** 由报销单状态推导时间线节点 */
function buildTimeline(c: ExpenseClaim): TimelineNode[] {
  const st = c.status
  const nodes: TimelineNode[] = []

  // 1. 创建
  nodes.push({
    key: 'create',
    icon: <Circle className="h-3.5 w-3.5" />,
    title: '创建报销单',
    actor: `${c.payee?.name ?? '—'} 创建`,
    time: fmtClaimDateTime(c.createdAt),
    detail: `${c.items.length} 条明细 · 合计 ${fmtClaimAmount(c.totalAmount)}`,
    tone: 'neutral',
  })

  // 2. 提交审批（DRAFT=未发生）
  if (st === 'DRAFT') {
    nodes.push({
      key: 'submit',
      icon: <CircleDashed className="h-3.5 w-3.5" />,
      title: '提交审批',
      actor: '待报销人提交',
      tone: 'pending',
    })
  } else {
    nodes.push({
      key: 'submit',
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      title: '提交审批',
      actor: `${c.payee?.name ?? '—'} 提交`,
      time: fmtClaimDateTime(claimSubmittedAt(c)),
      tone: 'done',
    })
  }

  // 3. 审批（SUBMITTED=待审批；REJECTED=驳回；APPROVED/PAID=通过）
  if (st === 'SUBMITTED') {
    nodes.push({
      key: 'approve',
      icon: <Clock3 className="h-3.5 w-3.5" />,
      title: '管理员审批',
      actor: '等待管理员审批',
      tone: 'current',
    })
  } else if (st === 'REJECTED') {
    nodes.push({
      key: 'approve',
      icon: <XCircle className="h-3.5 w-3.5" />,
      title: '管理员驳回',
      actor: `${c.approvedBy?.name ?? '管理员'} 驳回`,
      time: c.approvedAt ? fmtClaimDateTime(c.approvedAt) : null,
      detail: c.rejectedReason ? `驳回原因：${c.rejectedReason}` : null,
      tone: 'danger',
    })
  } else if (st === 'APPROVED' || st === 'PAID') {
    nodes.push({
      key: 'approve',
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      title: '管理员审批通过',
      actor: `${c.approvedBy?.name ?? '—'} 审批通过`,
      time: c.approvedAt ? fmtClaimDateTime(c.approvedAt) : null,
      tone: 'done',
    })
  }

  // 4. 打款（仅 PAID 完成；APPROVED=待打款）
  if (st === 'APPROVED') {
    nodes.push({
      key: 'pay',
      icon: <Clock3 className="h-3.5 w-3.5" />,
      title: '财务打款',
      actor: '等待财务部打款',
      tone: 'current',
    })
  } else if (st === 'PAID') {
    nodes.push({
      key: 'pay',
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      title: '财务打款完成',
      actor: `${c.paidBy?.name ?? '—'} 打款`,
      time: c.paidAt ? fmtClaimDateTime(c.paidAt) : null,
      tone: 'done',
    })
  }

  // REJECTED 之后：重新编辑提示
  if (st === 'REJECTED') {
    nodes.push({
      key: 'reedit',
      icon: <CircleDashed className="h-3.5 w-3.5" />,
      title: '等待重新编辑',
      actor: '报销人可在列表中「重新编辑」退回草稿修改后再次提交',
      tone: 'pending',
    })
  }

  return nodes
}

export function ExpenseClaimDetailDialog({ open, onOpenChange, claim }: ExpenseClaimDetailDialogProps) {
  if (!claim) return null

  const timeline = buildTimeline(claim)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>报销单 {claimNo(claim.id)}</DialogTitle>
          <DialogDescription>
            {claim.payee?.name ?? '—'} 报销 · {claim.items.length} 条明细 · 创建于{' '}
            {fmtClaimDateTime(claim.createdAt)}
          </DialogDescription>
        </DialogHeader>

        {/* ── 头部：状态 + 总额 + 审批人/打款人 ── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-4 py-3">
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs font-semibold',
              CLAIM_STATUS_CLS[claim.status],
            )}
          >
            {CLAIM_STATUS_TEXT[claim.status]}
          </span>
          <div>
            <p className="text-xs text-muted-foreground">报销总额</p>
            <p className="font-mono text-lg font-semibold">{fmtClaimAmount(claim.totalAmount)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">审批人</p>
            <p className="text-sm font-medium">{claim.approvedBy?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">打款人</p>
            <p className="text-sm font-medium">{claim.paidBy?.name ?? '—'}</p>
          </div>
          {claim.remark && (
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">备注</p>
              <p className="truncate text-sm" title={claim.remark}>
                {claim.remark}
              </p>
            </div>
          )}
        </div>

        {/* ── 费用明细表 ── */}
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            费用明细
            <Badge variant="secondary" className="font-normal">
              {claim.items.length} 条
            </Badge>
          </h4>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">分类</th>
                  <th className="px-3 py-2 text-right font-medium">金额</th>
                  <th className="px-3 py-2 font-medium">日期</th>
                  <th className="px-3 py-2 font-medium">说明</th>
                </tr>
              </thead>
              <tbody>
                {claim.items.map((it, i) => (
                  <tr key={it.id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{i + 1}</td>
                    <td className="whitespace-nowrap px-3 py-2">{it.category?.name ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      {fmtClaimAmount(it.amount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtClaimDate(it.expenseDate)}</td>
                    <td className="max-w-[220px] px-3 py-2">
                      <span className="block truncate" title={it.description ?? ''}>
                        {it.description || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/30">
                  <td className="px-3 py-2 text-xs font-medium" colSpan={2}>
                    合计
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold">
                    {fmtClaimAmount(claim.totalAmount)}
                  </td>
                  <td className="px-3 py-2" colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 审批时间线（竖向） ── */}
        <div>
          <h4 className="mb-3 text-sm font-semibold">审批时间线</h4>
          <ol className="relative ml-2 space-y-0">
            {timeline.map((n, i) => {
              const last = i === timeline.length - 1
              return (
                <li key={n.key} className="relative flex gap-3 pb-5">
                  {/* 连接线 */}
                  {!last && (
                    <span
                      className="absolute left-[9px] top-6 h-[calc(100%-14px)] w-px bg-border"
                      aria-hidden
                    />
                  )}
                  {/* 节点圆标 */}
                  <span
                    className={cn(
                      'z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      TONE_CLS[n.tone],
                    )}
                  >
                    {n.icon}
                  </span>
                  {/* 内容 */}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {n.actor}
                      {n.time && <span className="ml-2 font-mono">{n.time}</span>}
                    </p>
                    {n.detail && (
                      <p
                        className={cn(
                          'mt-1 rounded-md border px-2 py-1 text-xs',
                          n.tone === 'danger'
                            ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40'
                            : 'border-border bg-muted/40 text-muted-foreground',
                        )}
                      >
                        {n.detail}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  )
}
