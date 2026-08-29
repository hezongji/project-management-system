'use client'

/**
 * 采购订单状态标签条（★ V3 P0 2026-08-22，见设计方案-采购管理-v3 §三）
 *
 * 横向标签链：草稿→待合同→合同确认→已下单→备货中→已发货→部分到货→已完成
 * 当前态高亮、已过态打 ✓、未来态灰；CANCELLED 红色终态。
 * 「下一步」按钮按状态给出对应操作（发起合同/确认合同/正式下单/登记付款/登记发货/登记到货），
 * 点击由父组件打开对应弹窗；后端 advance API 会再做白名单+权限校验。
 *
 * ⚠️ 常量镜像自 src/lib/purchase-workflow.ts（该文件含 prisma，不可被客户端组件 import）；
 *    两处需保持同步。
 */

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Check, XCircle, ChevronRight, PackageCheck } from 'lucide-react'

/** 状态链（顺序即展示顺序；镜像 purchase-workflow.ORDER_STATUS_META） */
export const PURCHASE_ORDER_CHAIN: Array<{ value: string; label: string }> = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'CONTRACT_PENDING', label: '待合同' },
  { value: 'CONFIRMED', label: '合同确认' },
  { value: 'ORDERED', label: '已下单' },
  { value: 'PREPARING', label: '备货中' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'PARTIAL', label: '部分到货' },
  { value: 'COMPLETED', label: '已完成' },
]

export const PURCHASE_STATUS_LABEL: Record<string, string> = {
  ...Object.fromEntries(PURCHASE_ORDER_CHAIN.map((s) => [s.value, s.label])),
  CANCELLED: '已取消',
}

/** 推进动作（镜像 purchase-workflow.ADVANCE_ACTIONS 的 label） */
export type PurchaseAdvanceAction =
  | 'START_CONTRACT'
  | 'CONFIRM_CONTRACT'
  | 'PLACE_ORDER'
  | 'MARK_PREPARING'
  | 'MARK_SHIPPED'
  | 'CANCEL'

/** 各状态允许的下一步（镜像 ORDER_TRANSITIONS，去掉 CANCELLED） */
export const NEXT_STEP: Record<
  string,
  { kind: 'advance'; action: PurchaseAdvanceAction; label: string } | { kind: 'arrival'; label: string } | null
> = {
  DRAFT: { kind: 'advance', action: 'START_CONTRACT', label: '发起合同' },
  CONTRACT_PENDING: { kind: 'advance', action: 'CONFIRM_CONTRACT', label: '确认合同与价格' },
  CONFIRMED: { kind: 'advance', action: 'PLACE_ORDER', label: '正式下单' },
  ORDERED: { kind: 'advance', action: 'MARK_PREPARING', label: '登记付款·备货' },
  PREPARING: { kind: 'advance', action: 'MARK_SHIPPED', label: '登记发货' },
  SHIPPED: { kind: 'arrival', label: '登记到货·收货' },
  PARTIAL: { kind: 'arrival', label: '继续登记到货' },
  COMPLETED: null,
  CANCELLED: null,
}

export interface OrderStatusBarProps {
  status: string
  /** 采购部/ADMIN（可推进）；财务另可「登记付款」 */
  canOperate: boolean
  /** 财务部（MARK_PREPARING 允许） */
  canFinance?: boolean
  /** 下一步按钮点击：advance 动作或到货登记 */
  onAdvance?: (action: PurchaseAdvanceAction) => void
  onArrival?: () => void
  acting?: boolean
  className?: string
}

export function OrderStatusBar({
  status,
  canOperate,
  canFinance = false,
  onAdvance,
  onArrival,
  acting = false,
  className,
}: OrderStatusBarProps) {
  if (status === 'CANCELLED') {
    return (
      <div className={cn('flex items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 py-2.5 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400', className)}>
        <XCircle className="h-4 w-4" />
        订单已取消（终态）
      </div>
    )
  }

  const currentIndex = PURCHASE_ORDER_CHAIN.findIndex((s) => s.value === status)
  const next = NEXT_STEP[status] ?? null
  // 付款步骤（ORDERED→PREPARING）允许采购或财务；其余仅采购/ADMIN
  const canNext =
    canOperate || (next?.kind === 'advance' && next.action === 'MARK_PREPARING' && canFinance)

  return (
    <div className={cn('space-y-2', className)}>
      {/* 标签链 */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
        {PURCHASE_ORDER_CHAIN.map((s, i) => {
          const isPast = currentIndex > i
          const isCurrent = currentIndex === i
          return (
            <React.Fragment key={s.value}>
              {i > 0 && (
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    isPast || isCurrent ? 'text-primary' : 'text-muted-foreground/40',
                  )}
                />
              )}
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  isCurrent
                    ? 'border-primary bg-primary text-primary-foreground font-medium shadow-sm'
                    : isPast
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground/60',
                )}
              >
                {isPast && <Check className="h-3 w-3" />}
                {s.label}
              </span>
            </React.Fragment>
          )
        })}
      </div>

      {/* 下一步操作 */}
      {next && (
        <div className="flex flex-wrap items-center gap-2">
          {canNext ? (
            next.kind === 'advance' ? (
              <Button size="sm" onClick={() => onAdvance?.(next.action)} disabled={acting}>
                {next.label}
              </Button>
            ) : (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => onArrival?.()}
                disabled={acting}
              >
                <PackageCheck className="mr-1 h-3.5 w-3.5" /> {next.label}
              </Button>
            )
          ) : (
            <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
              下一步：{next.label}（需采购人员操作）
            </Badge>
          )}
          {canOperate && status !== 'COMPLETED' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => onAdvance?.('CANCEL')}
              disabled={acting}
            >
              取消/作废
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
