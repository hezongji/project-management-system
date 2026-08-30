'use client'

/**
 * MobilePurchase —— 采购模块移动子树（spec §3.7，S3-W4）。
 * 数据查询/审批逻辑/金额口径全部留在页面层，本组件只做移动端展示容器：
 *   状态组卡 → 横滑状态 chips（点击=状态过滤，复用页面 STATUS_GROUPS 逻辑）
 *   金额汇总 → 「概览」Sheet（金额字符串由页面 fmtMoney 生成后传入，口径不重写）
 *   三 Tab → MobileSegmentedTabs；订单表 → 卡片流（触底翻页累积，同 tasks 模式）
 *   项目/类别/供应商筛选 → 底部 Sheet 选项列表
 *   订单/清单/需求详情与新建表单弹窗 → 页面挂载的 ResponsiveDialog（移动端自动变 Sheet）
 */

import * as React from 'react'
import {
  BadgeCheck,
  ChevronRight,
  ClipboardList,
  ShoppingCart,
  Truck,
  FileDown,
  FileStack,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { MobileList } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { MobileSegmentedTabs } from './segmented-tabs'
import { MobileEmptyState } from './empty-state'
import { cn } from '@/lib/utils'

/* ── 与页面契约对齐的视图层类型（宽松复制，page.tsx 为权威） ── */

interface OrderRow {
  id: string
  code: string
  title: string
  category: string
  status: string
  isSupplementary: boolean
  amount: number | null
  plannedArrivalDate: string | null
  createdAt: string
  project: { code: string; name: string }
  supplier: { name: string } | null
  creator?: { id: string; name?: string } | null
  owner?: { id: string; name?: string } | null
  _count: { items: number; arrivals: number }
}

interface RequestRow {
  id: string
  code: string
  title: string
  category: string
  priority: string
  status: string
  rejectReason: string | null
  expectedArrivalDate: string | null
  createdAt: string
  requester: { id: string; name: string }
  handler: { name: string } | null
  project: { id: string; code: string; name: string }
  _count: { items: number; supplierRequests: number }
}

interface SupplierRequestRow {
  id: string
  code: string
  title: string | null
  status: string
  quoteAmount: number | null
  createdAt: string
  supplier: { name: string } | null
  request: { code: string; title: string } | null
  project: { code: string; name: string }
  order: { code: string } | null
  creator?: { id: string } | null
  _count: { items: number }
}

/* ── 状态/类别标签（与 page.tsx 常量同步） ── */

const ORDER_STATUS_META: Record<string, { label: string; tone: MobileChipTone }> = {
  DRAFT: { label: '草稿', tone: 'default' },
  CONTRACT_PENDING: { label: '待合同', tone: 'warning' },
  CONFIRMED: { label: '合同确认', tone: 'info' },
  ORDERED: { label: '已下单·待付款', tone: 'info' },
  PREPARING: { label: '备货中', tone: 'primary' },
  SHIPPED: { label: '已发货', tone: 'info' },
  PARTIAL: { label: '部分到货', tone: 'warning' },
  COMPLETED: { label: '已完成', tone: 'success' },
  CANCELLED: { label: '已取消', tone: 'default' },
}
const STATUS_GROUPS: Record<string, { label: string }> = {
  PENDING: { label: '待处理' },
  ACTIVE: { label: '进行中' },
}
const CATEGORY_LABEL: Record<string, string> = {
  MECHANICAL: '机械',
  ELECTRICAL: '电气',
  OTHER: '其他',
}
const PR_STATUS_META: Record<string, { label: string; tone: MobileChipTone }> = {
  DRAFT: { label: '草稿', tone: 'default' },
  SUBMITTED: { label: '已提交', tone: 'info' },
  PROCESSING: { label: '处理中', tone: 'primary' },
  DECOMPOSED: { label: '已分解', tone: 'info' },
  COMPLETED: { label: '已完成', tone: 'success' },
  REJECTED: { label: '已驳回', tone: 'danger' },
}
const SR_STATUS: Record<string, { label: string; tone: MobileChipTone }> = {
  DRAFT: { label: '草稿', tone: 'default' },
  PUBLISHED: { label: '已发布', tone: 'info' },
  QUOTED: { label: '已报价', tone: 'primary' },
  ORDERED: { label: '已下单', tone: 'success' },
  CANCELLED: { label: '已取消', tone: 'default' },
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN')}`
const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('zh-CN') : '—'

export interface MobilePurchaseProps {
  /* Tab */
  tab: string
  onTabChange: (t: string) => void
  /* 订单列表（触底翻页累积） */
  orders: OrderRow[]
  ordersLoading: boolean
  ordersQueryKey: string
  ordersPage: number
  ordersPages: number
  onOrdersPageChange: (p: number) => void
  /* 采购清单 */
  requests: RequestRow[]
  requestsLoading: boolean
  mineOnly: boolean
  onMineOnlyChange: (v: boolean) => void
  /* 供应商需求 */
  srs: SupplierRequestRow[]
  srsLoading: boolean
  /* 筛选（立即生效，页面持有状态） */
  statusFilter: string
  onStatusFilterChange: (v: string) => void
  categoryFilter: string
  onCategoryFilterChange: (v: string) => void
  projectFilter: string
  onProjectFilterChange: (v: string) => void
  supplierFilter: string
  onSupplierFilterChange: (v: string) => void
  projectOptions: Array<{ id: string; code: string; name: string }>
  supplierOptions: Array<{ id: string; name: string }>
  urlProjectId: string
  onClearProjectUrl: () => void
  /* 概览数据（金额字符串由页面 fmtMoney 生成，口径不重写） */
  statusCounts: Record<string, number> | undefined
  moneyOverview: { pending: number; active: number; done: number; month: string; total: string }
  /* 跨页定位闪烁 */
  flashOrderId: string | null
  orderRowRef: { current: HTMLElement | null }
  flashRequestId: string | null
  requestRowRef: { current: HTMLElement | null }
  focusId: string | null
  srcLabel: string | null
  onClearFocus: () => void
  /* 身份 */
  isPurchase: boolean
  currentUserId?: string
  /* 动作回调（页面业务逻辑） */
  onStatCardClick: (group: 'PENDING' | 'ACTIVE' | 'COMPLETED') => void
  onOpenDetail: (id: string) => void
  onOpenSrDetail: (id: string) => void
  onOpenCreate: (supplementary: boolean) => void
  onOpenRequestForm: () => void
  onOpenWorkbench: () => void
  onOpenConsolidated: () => void
  onDeleteOrder: (o: OrderRow) => void
  onDeleteSr: (sr: SupplierRequestRow) => void
  /* SR 多选归单 */
  srSelected: Set<string>
  onSrSelectedChange: (s: Set<string>) => void
  selectableSrs: string[]
  generating: boolean
  onGenerateOrders: () => void
  /* 导出 */
  exporting: boolean
  onExportOrders: () => void
  onExportRequests: () => void
}

export function MobilePurchase(props: MobilePurchaseProps) {
  const {
    tab, onTabChange,
    orders, ordersLoading, ordersQueryKey, ordersPage, ordersPages, onOrdersPageChange,
    requests, requestsLoading, mineOnly, onMineOnlyChange,
    srs, srsLoading,
    statusFilter, onStatusFilterChange, categoryFilter, onCategoryFilterChange,
    projectFilter, onProjectFilterChange, supplierFilter, onSupplierFilterChange,
    projectOptions, supplierOptions, urlProjectId, onClearProjectUrl,
    statusCounts, moneyOverview,
    flashOrderId, orderRowRef, flashRequestId, requestRowRef, focusId, srcLabel, onClearFocus,
    isPurchase, currentUserId,
    onStatCardClick, onOpenDetail, onOpenSrDetail,
    onOpenCreate, onOpenRequestForm, onOpenWorkbench, onOpenConsolidated,
    onDeleteOrder, onDeleteSr,
    srSelected, onSrSelectedChange, selectableSrs, generating, onGenerateOrders,
    exporting, onExportOrders, onExportRequests,
  } = props

  const [filterOpen, setFilterOpen] = React.useState(false)
  const [overviewOpen, setOverviewOpen] = React.useState(false)

  /* ── 订单触底翻页累积（同 tasks.tsx 模式；筛选变化 → 页面重置 page=1 → 重置累积） ── */
  const [acc, setAcc] = React.useState<OrderRow[]>(orders)
  const lastKeyRef = React.useRef(ordersQueryKey)
  React.useEffect(() => {
    if (ordersPage === 1 || lastKeyRef.current !== ordersQueryKey) {
      lastKeyRef.current = ordersQueryKey
      setAcc(orders)
    } else {
      setAcc((prev) => {
        const seen = new Set(prev.map((o) => o.id))
        return [...prev, ...orders.filter((o) => !seen.has(o.id))]
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, ordersPage, ordersQueryKey])

  const hasMore = ordersPage < ordersPages
  const loadingMore = ordersLoading && ordersPage > 1

  const sentinelRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !ordersLoading) onOrdersPageChange(ordersPage + 1)
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, ordersLoading, ordersPage, onOrdersPageChange])

  /* ── 状态 chips（按 Tab 适配值域；订单组带 count） ── */
  const chips: Array<{ v: string; label: string; count?: number }> =
    tab === 'requests'
      ? [
          { v: 'all', label: '全部' },
          ...Object.entries(PR_STATUS_META).map(([v, m]) => ({ v, label: m.label })),
        ]
      : tab === 'srs'
        ? [
            { v: 'all', label: '全部' },
            ...Object.entries(SR_STATUS).map(([v, m]) => ({ v, label: m.label })),
          ]
        : [
            { v: 'all', label: '全部' },
            { v: 'PENDING', label: STATUS_GROUPS.PENDING.label, count: moneyOverview.pending },
            { v: 'ACTIVE', label: STATUS_GROUPS.ACTIVE.label, count: moneyOverview.active },
            { v: 'COMPLETED', label: '已完成', count: moneyOverview.done },
            ...Object.entries(ORDER_STATUS_META).map(([v, m]) => ({
              v,
              label: m.label,
              count: statusCounts?.[v],
            })),
          ]

  const activeFilterCount =
    (projectFilter ? 1 : 0) +
    (categoryFilter !== 'all' ? 1 : 0) +
    (supplierFilter ? 1 : 0)

  const filteredRequests = React.useMemo(
    () => (mineOnly ? requests.filter((pr) => pr.requester?.id === currentUserId) : requests),
    [requests, mineOnly, currentUserId],
  )

  /* ── 筛选 Sheet 选项行 ── */
  const FilterRow = ({
    active,
    label,
    onClick,
  }: {
    active: boolean
    label: React.ReactNode
    onClick: () => void
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full items-center justify-between rounded-md px-3 text-left text-sm active:bg-muted/60',
        active ? 'bg-primary/10 font-medium text-primary' : 'text-foreground',
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      {active && <BadgeCheck className="h-4 w-4 shrink-0" />}
    </button>
  )

  return (
    <div className="space-y-2.5 px-3 pb-4 pt-1">
      {/* 定位来源提示条 */}
      {srcLabel && (
        <div className="flex items-center">
          <Badge variant="outline" className="gap-1 font-normal">
            已定位 · 来自：{srcLabel}
            <button
              type="button"
              onClick={onClearFocus}
              className="ml-0.5 flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="关闭定位提示"
            >
              ✕
            </button>
          </Badge>
        </div>
      )}

      {/* 动作横滑条（全部入口可达，触控 ≥44px） */}
      <div
        className="-mx-3 flex gap-2 overflow-x-auto px-3 py-0.5"
        style={{ scrollbarWidth: 'none' }}
      >
        <button
          type="button"
          onClick={() => onOpenCreate(false)}
          className="btn-gradient flex h-11 shrink-0 items-center gap-1 rounded-md px-4 text-sm font-medium text-primary-foreground"
        >
          + 新建订单
        </button>
        <Button variant="outline" className="h-11 shrink-0" onClick={() => onOpenCreate(true)}>
          追加采购
        </Button>
        <Button variant="outline" className="h-11 shrink-0" onClick={onOpenRequestForm}>
          提需求
        </Button>
        <Button variant="outline" className="h-11 shrink-0" onClick={onOpenWorkbench}>
          <Sparkles className="mr-1 h-4 w-4" /> AI 导入
        </Button>
        <Button variant="outline" className="h-11 shrink-0" onClick={onOpenConsolidated}>
          <FileStack className="mr-1 h-4 w-4" /> 总清单
        </Button>
        <Button variant="outline" className="h-11 shrink-0" onClick={() => setOverviewOpen(true)}>
          概览
        </Button>
      </div>

      {/* 三 Tab */}
      <MobileSegmentedTabs
        tabs={[
          { key: 'orders', label: '采购订单' },
          { key: 'requests', label: '采购清单' },
          { key: 'srs', label: '供应商需求' },
        ]}
        active={tab}
        onChange={onTabChange}
      />

      {/* 状态 chips 横滑（点击=状态过滤） */}
      <div
        className="-mx-3 flex gap-2 overflow-x-auto px-3 py-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {chips.map((c) => {
          const active = statusFilter === c.v
          return (
            <button
              key={c.v}
              type="button"
              onClick={() => onStatusFilterChange(c.v)}
              className={cn(
                'flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs',
                active
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border bg-card text-muted-foreground',
              )}
            >
              <span>{c.label}</span>
              {c.count != null && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] leading-4',
                    active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {c.count > 99 ? '99+' : c.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        {urlProjectId && (
          <Badge variant="outline" className="gap-1 font-normal">
            按项目过滤
            <button
              type="button"
              onClick={onClearProjectUrl}
              className="ml-0.5 flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="取消按项目过滤"
            >
              ✕
            </button>
          </Badge>
        )}
        <button
          type="button"
          onClick={() => setFilterOpen(true)}
          className={cn(
            'flex h-11 items-center gap-1.5 rounded-md border px-3 text-sm',
            activeFilterCount > 0
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-border bg-card text-foreground',
          )}
        >
          <SlidersHorizontal className="h-4 w-4" />
          筛选
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
              {activeFilterCount}
            </span>
          )}
        </button>
        {tab === 'requests' && (
          <button
            type="button"
            onClick={() => onMineOnlyChange(!mineOnly)}
            className={cn(
              'flex h-11 items-center gap-1.5 rounded-md border px-3 text-sm',
              mineOnly
                ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                : 'border-border bg-card text-foreground',
            )}
          >
            <UserRound className="h-4 w-4" /> 我的清单
          </button>
        )}
      </div>

      {/* ── Tab1 采购订单：卡片流 + 触底加载 ── */}
      {tab === 'orders' && (
        <>
          <MobileList
            items={acc}
            keyOf={(o) => o.id}
            loading={ordersLoading && ordersPage === 1}
            empty={
              <MobileEmptyState
                icon={ShoppingCart}
                title="暂无采购订单"
                desc="点击上方「新建订单」开始"
              />
            }
            renderItem={(o) => {
              const meta = ORDER_STATUS_META[o.status] ?? { label: o.status, tone: 'default' as MobileChipTone }
              const canDelete =
                o.status === 'DRAFT' &&
                (isPurchase || o.creator?.id === currentUserId || o.owner?.id === currentUserId)
              return (
                <div
                  ref={o.id === flashOrderId ? (el) => { orderRowRef.current = el } : undefined}
                  data-focus-id={o.id === focusId ? o.id : undefined}
                  className={cn(
                    'flex cursor-pointer items-start gap-1 px-3.5 py-3 active:bg-muted/60',
                    o.id === flashOrderId && 'focus-ring-flash',
                  )}
                  onClick={() => onOpenDetail(o.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{o.code}</span>
                      {o.isSupplementary && (
                        <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
                          追加
                        </Badge>
                      )}
                      <span className="ml-auto shrink-0">
                        <MobileStatusChip label={meta.label} tone={meta.tone} />
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm">{o.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="font-mono text-primary">{o.project.code}</span>
                      <span className="min-w-0 truncate">{o.supplier?.name ?? '—'}</span>
                      <span className="font-mono">{fmtMoney(o.amount)}</span>
                      <span>{fmtDate(o.createdAt)}</span>
                    </p>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      aria-label={'删除订单 ' + o.code}
                      className="flex h-11 shrink-0 items-center px-1 text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteOrder(o)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                  <ChevronRight className="mt-3.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                </div>
              )
            }}
          />
          <div ref={sentinelRef} className="h-1" />
          {loadingMore && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!hasMore && acc.length > 0 && (
            <p className="py-1 text-center text-xs text-muted-foreground">已加载全部订单</p>
          )}
          {acc.length > 0 && (
            <button
              type="button"
              onClick={onExportOrders}
              disabled={exporting}
              className="flex h-11 w-full items-center justify-center gap-1 rounded-md border border-border text-sm text-muted-foreground active:bg-muted/60"
            >
              <FileDown className="h-4 w-4" /> 导出Excel（按当前筛选）
            </button>
          )}
        </>
      )}

      {/* ── Tab2 采购清单：卡片流（我的清单前端过滤，与桌面一致） ── */}
      {tab === 'requests' && (
        <>
          {!requestsLoading && filteredRequests.length > 0 ? (
            <button
              type="button"
              onClick={onExportRequests}
              disabled={exporting}
              className="flex h-11 w-full items-center justify-center gap-1 rounded-md border border-border text-sm text-muted-foreground active:bg-muted/60"
            >
              <FileDown className="h-4 w-4" /> 导出Excel
            </button>
          ) : null}
          <MobileList
            items={filteredRequests}
            keyOf={(pr) => pr.id}
            loading={requestsLoading}
            empty={
              mineOnly ? (
                <MobileEmptyState
                  icon={ClipboardList}
                  title="没有你发布的采购清单"
                  desc="点「提需求」发起，或取消「我的清单」查看全部"
                />
              ) : (
                <MobileEmptyState
                  icon={ClipboardList}
                  title="暂无采购清单"
                  desc="点击上方「提需求」发起"
                />
              )
            }
            renderItem={(pr) => {
              const meta = PR_STATUS_META[pr.status] ?? { label: pr.status, tone: 'default' as MobileChipTone }
              return (
                <div
                  ref={pr.id === flashRequestId ? (el) => { requestRowRef.current = el } : undefined}
                  data-focus-id={pr.id === focusId ? pr.id : undefined}
                  className={cn('px-3.5 py-3', pr.id === flashRequestId && 'focus-ring-flash')}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">{pr.code}</span>
                    {pr.priority === 'URGENT' && (
                      <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
                        紧急
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0">
                      <MobileStatusChip label={meta.label} tone={meta.tone} />
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm">{pr.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-mono text-primary">{pr.project.code}</span>
                    <span className="min-w-0 truncate">{pr.project.name}</span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span>物料 {pr._count.items} 项</span>
                    {pr._count.supplierRequests > 0 && <span>分解 {pr._count.supplierRequests} 个</span>}
                    <span>期望到货 {fmtDate(pr.expectedArrivalDate)}</span>
                    <span>{pr.requester?.name ?? '—'}</span>
                    <span>{fmtDate(pr.createdAt)}</span>
                  </p>
                  {pr.status === 'REJECTED' && pr.rejectReason && (
                    <p className="mt-1 text-[11px] text-destructive">驳回原因:{pr.rejectReason}</p>
                  )}
                </div>
              )
            }}
          />
        </>
      )}

      {/* ── Tab3 供应商需求：卡片流 + 多选归单 ── */}
      {tab === 'srs' && (
        <>
          {isPurchase && srs.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-card p-2.5">
              <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
                勾选任务（需已指定供应商）→ 按供应商归纳生成订单
              </p>
              <Button
                className="h-11 shrink-0"
                disabled={srSelected.size === 0 || generating}
                onClick={onGenerateOrders}
              >
                {generating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                生成订单（{srSelected.size}）
              </Button>
            </div>
          )}
          <MobileList
            items={srs}
            keyOf={(sr) => sr.id}
            loading={srsLoading}
            empty={
              <MobileEmptyState
                icon={Truck}
                title="暂无供应商需求"
                desc="在采购清单受理后分解生成，或由采购直接创建"
              />
            }
            renderItem={(sr) => {
              const meta = SR_STATUS[sr.status] ?? { label: sr.status, tone: 'default' as MobileChipTone }
              const selectable = ['PUBLISHED', 'QUOTED'].includes(sr.status) && !sr.order?.code
              const canDelete =
                (sr.status === 'DRAFT' || sr.status === 'CANCELLED') &&
                (isPurchase || sr.creator?.id === currentUserId)
              return (
                <div
                  className={cn(
                    'flex cursor-pointer items-start gap-1 px-3.5 py-3 active:bg-muted/60',
                    srSelected.has(sr.id) && 'bg-primary/5',
                  )}
                  onClick={() => onOpenSrDetail(sr.id)}
                >
                  {isPurchase && (
                    <div
                      className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {selectable ? (
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={srSelected.has(sr.id)}
                          onChange={(e) => {
                            const next = new Set(srSelected)
                            if (e.target.checked) next.add(sr.id)
                            else next.delete(sr.id)
                            onSrSelectedChange(next)
                          }}
                        />
                      ) : null}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{sr.code}</span>
                      <span className="ml-auto shrink-0">
                        <MobileStatusChip label={meta.label} tone={meta.tone} />
                      </span>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {sr.request ? (
                        <span className="font-mono text-primary">{sr.request.code}</span>
                      ) : (
                        <span>独立发起</span>
                      )}
                      <span className="min-w-0 truncate">{sr.supplier?.name ?? '—'}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="font-mono">{fmtMoney(sr.quoteAmount)}</span>
                      {sr.order?.code && <span className="font-mono">→ {sr.order.code}</span>}
                      <span>{fmtDate(sr.createdAt)}</span>
                    </p>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      aria-label={'删除供应商需求 ' + sr.code}
                      className="flex h-11 shrink-0 items-center px-1 text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteSr(sr)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                  <ChevronRight className="mt-3.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                </div>
              )
            }}
          />
        </>
      )}

      {/* ── 筛选 Sheet（项目/类别/供应商，点选立即生效） ── */}
      <Sheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="筛选"
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={() => {
                onProjectFilterChange('')
                onCategoryFilterChange('all')
                onSupplierFilterChange('')
              }}
            >
              重置
            </Button>
            <Button className="h-11 flex-1" onClick={() => setFilterOpen(false)}>
              完成
            </Button>
          </div>
        }
      >
        <div className="space-y-4 pb-2">
          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">项目</p>
            <div className="space-y-0.5">
              <FilterRow active={!projectFilter} label="全部项目" onClick={() => onProjectFilterChange('')} />
              {projectOptions.map((p) => (
                <FilterRow
                  key={p.id}
                  active={projectFilter === p.id}
                  label={p.code + ' · ' + p.name}
                  onClick={() => onProjectFilterChange(p.id)}
                />
              ))}
            </div>
          </section>
          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">类别</p>
            <div className="space-y-0.5">
              <FilterRow
                active={categoryFilter === 'all'}
                label="全部类别"
                onClick={() => onCategoryFilterChange('all')}
              />
              {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                <FilterRow
                  key={v}
                  active={categoryFilter === v}
                  label={l}
                  onClick={() => onCategoryFilterChange(v)}
                />
              ))}
            </div>
          </section>
          {tab !== 'requests' && (
            <section>
              <p className="mb-1 text-xs font-medium text-muted-foreground">供应商</p>
              <div className="space-y-0.5">
                <FilterRow
                  active={!supplierFilter}
                  label="全部供应商"
                  onClick={() => onSupplierFilterChange('')}
                />
                {supplierOptions.map((s) => (
                  <FilterRow
                    key={s.id}
                    active={supplierFilter === s.id}
                    label={s.name}
                    onClick={() => onSupplierFilterChange(s.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </Sheet>

      {/* ── 概览 Sheet（金额字符串由页面 fmtMoney 生成，口径不重写） ── */}
      <Sheet open={overviewOpen} onClose={() => setOverviewOpen(false)} title="采购概览">
        <div className="space-y-3 pb-2">
          {(
            [
              { title: '待处理（草稿/待合同/合同确认）', value: moneyOverview.pending, group: 'PENDING' as const, cls: 'text-amber-500' },
              { title: '进行中（下单/备货/发货/部分到货）', value: moneyOverview.active, group: 'ACTIVE' as const, cls: 'text-blue-500' },
              { title: '已完成', value: moneyOverview.done, group: 'COMPLETED' as const, cls: 'text-emerald-500' },
            ] as const
          ).map(({ title, value, group, cls }) => (
            <button
              key={group}
              type="button"
              onClick={() => {
                setOverviewOpen(false)
                onStatCardClick(group)
              }}
              className="flex min-h-11 w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-left active:bg-muted/60"
            >
              <span className="text-sm text-muted-foreground">{title}</span>
              <span className={cn('text-xl font-semibold', cls)}>{value}</span>
            </button>
          ))}
          <div className="rounded-lg border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">本月金额</p>
            <p className="mt-1 font-mono text-lg font-semibold">{moneyOverview.month}</p>
            <p className="mt-2 text-xs text-muted-foreground">累计总金额</p>
            <p className="mt-0.5 font-mono text-sm">{moneyOverview.total}</p>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            点击分类卡片可筛选并定位到列表首条
          </p>
        </div>
      </Sheet>
    </div>
  )
}
