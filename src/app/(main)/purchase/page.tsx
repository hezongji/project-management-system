'use client'

/**
 * /purchase —— 采购管理主页（2026-08-22 采购模块 Step 3）
 *
 * 三个 Tab：采购订单 | 采购清单（成员提需求）| 供应商需求
 * 统计卡：待下单 / 进行中 / 已完成 / 总金额（无财务权限显示 —）
 * ★ 2026-08-25：采购清单 Tab 由卡片流改为表格样式（信息/功能不减，仅换布局）
 * ★ 2026-08-25：统计卡可点击——按卡片状态组过滤订单列表并滚动定位/闪烁首条（金额卡不可点）
 * 权限：PageGuard pageKey='purchase'；采购部身份由 department.name 判定
 */

import { PageGuard } from '@/components/layout/page-guard'
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusHighlight } from '@/hooks/use-focus-highlight'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TablePagination } from '@/components/ui/data-table'
import { ApiService } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { useToast } from '@/components/ui/use-toast'
import {
  ShoppingCart,
  ClipboardList,
  FileSpreadsheet,
  FileStack,
  Sparkles,
  ListChecks,
  Loader2,
  Plus,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  Clock,
  UserRound,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { OrderFormDialog } from '@/components/purchase/order-form-dialog'
import { OrderDetailDialog } from '@/components/purchase/order-detail-dialog'
import { RequestFormDialog } from '@/components/purchase/request-form-dialog'
import { AiPurchaseWorkbench } from '@/components/purchase/ai-purchase-workbench'
import { ConsolidatedListDialog } from '@/components/purchase/consolidated-list-dialog'
import { SupplierRequestDetailDialog } from '@/components/purchase/supplier-request-detail-dialog'
import { exportPurchaseOrders, exportPurchaseRequests } from '@/lib/excel-templates'
import { FileDown } from 'lucide-react'

// ───────────────────────────── 常量 ─────────────────────────────

/** ★ V3 九状态（与 lib/purchase-workflow.ORDER_STATUS_META 同步；链顺序见 order-status-bar.tsx） */
const ORDER_STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'bg-muted text-muted-foreground' },
  CONTRACT_PENDING: { label: '待合同', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  CONFIRMED: { label: '合同确认', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  ORDERED: { label: '已下单·待付款', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  PREPARING: { label: '备货中', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
  SHIPPED: { label: '已发货', cls: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300' },
  PARTIAL: { label: '部分到货', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  COMPLETED: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  CANCELLED: { label: '已取消', cls: 'bg-muted text-muted-foreground line-through' },
}

/** ★ 统计卡状态聚合组：点卡片=statusFilter 设为该组；API 仅支持单 status，组内由前端并行拉取合并（见 fetchOrdersResp） */
const STATUS_GROUPS: Record<string, { label: string; statuses: string[] }> = {
  PENDING: { label: '待处理', statuses: ['DRAFT', 'CONTRACT_PENDING', 'CONFIRMED'] },
  ACTIVE: { label: '进行中', statuses: ['ORDERED', 'PREPARING', 'SHIPPED', 'PARTIAL'] },
}

const CATEGORY_LABEL: Record<string, string> = {
  MECHANICAL: '机械',
  ELECTRICAL: '电气',
  OTHER: '其他',
}

const PR_STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'bg-muted text-muted-foreground' },
  SUBMITTED: { label: '已提交', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  PROCESSING: { label: '处理中', cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' },
  DECOMPOSED: { label: '已分解', cls: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300' },
  COMPLETED: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  REJECTED: { label: '已驳回', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

const PRIORITY_LABEL: Record<string, string> = { LOW: '不急', NORMAL: '常规', URGENT: '紧急' }

const SR_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  QUOTED: '已报价',
  ORDERED: '已下单',
  CANCELLED: '已取消',
}

/** ★ 筛选接线：三个 Tab 各自的状态筛选值域（Tab 切换时若当前值不在目标值域则重置为 all） */
const ORDER_STATUS_FILTERS = new Set([
  'all',
  ...Object.keys(STATUS_GROUPS),
  ...Object.keys(ORDER_STATUS_META),
])
const PR_STATUS_FILTERS = new Set(['all', ...Object.keys(PR_STATUS_META)])
const SR_STATUS_FILTERS = new Set(['all', ...Object.keys(SR_STATUS_LABEL)])

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `¥${Number(n).toLocaleString('zh-CN')}`

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('zh-CN') : '—'

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

interface OrdersResp {
  items: OrderRow[]
  pagination: { page: number; pages: number; total: number }
  stats?: {
    draft: number
    ordered: number
    partial: number
    inTransit: number
    completed: number
    cancelled: number
    totalAmount: number | null
    monthAmount: number | null
  }
}

/**
 * ★ 统计卡聚合组取数：API 仅支持单 status 筛选，聚合组（PENDING/ACTIVE）改为
 * 逐状态并行分块拉取（100/页、每状态上限 500，与导出/跨页定位同款模式），
 * 按 createdAt 倒序合并后在前端分页（20/页）；stats 各响应只含各自状态、逐字段求和还原组口径。
 */
const GROUP_CHUNK = 100
const GROUP_MAX_PER_STATUS = 500

async function fetchOrdersResp(qsStr: string): Promise<OrdersResp | undefined> {
  const params = new URLSearchParams(qsStr)
  const status = params.get('status')
  const group = status ? STATUS_GROUPS[status] : undefined
  if (!group) return ApiService.get<OrdersResp>(`/purchase-orders?${qsStr}`).then((r) => r.data)

  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  params.delete('status')
  params.delete('page')
  const baseQs = params.toString() // 保留项目/类别/供应商等其余筛选
  const perStatus = await Promise.all(
    group.statuses.map(async (s) => {
      const items: OrderRow[] = []
      let stats: OrdersResp['stats'] | undefined
      for (let p = 1; p <= Math.ceil(GROUP_MAX_PER_STATUS / GROUP_CHUNK); p++) {
        const qs = new URLSearchParams(baseQs)
        qs.set('status', s)
        qs.set('page', String(p))
        qs.set('limit', String(GROUP_CHUNK))
        const resp = await ApiService.get<OrdersResp>(`/purchase-orders?${qs}`).then((r) => r.data)
        if (!resp) break
        if (!stats) stats = resp.stats
        items.push(...resp.items)
        if (resp.items.length < GROUP_CHUNK || p >= resp.pagination.pages) break
      }
      return { items, stats }
    }),
  )
  const merged = perStatus
    .flatMap((r) => r.items)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const pages = Math.max(1, Math.ceil(merged.length / 20))
  const safePage = Math.min(page, pages)
  const statsList = perStatus
    .map((r) => r.stats)
    .filter((s): s is NonNullable<OrdersResp['stats']> => !!s)
  const sumNum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)
  const sumMoney = (ns: Array<number | null | undefined>) =>
    ns.length === 0 || ns.every((n) => n == null) ? null : sumNum(ns.map((n) => n ?? 0))
  return {
    items: merged.slice((safePage - 1) * 20, safePage * 20),
    pagination: { page: safePage, pages, total: merged.length },
    stats: statsList.length
      ? {
          draft: sumNum(statsList.map((s) => s.draft ?? 0)),
          ordered: sumNum(statsList.map((s) => s.ordered ?? 0)),
          partial: sumNum(statsList.map((s) => s.partial ?? 0)),
          inTransit: sumNum(statsList.map((s) => s.inTransit ?? 0)),
          completed: sumNum(statsList.map((s) => s.completed ?? 0)),
          cancelled: sumNum(statsList.map((s) => s.cancelled ?? 0)),
          totalAmount: sumMoney(statsList.map((s) => s.totalAmount)),
          monthAmount: sumMoney(statsList.map((s) => s.monthAmount)),
        }
      : undefined,
  }
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

// ───────────────────────────── 主组件 ─────────────────────────────

function PurchasePageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const { toast } = useToast()
  const confirm = useConfirm()
  const isPurchase =
    user?.role === 'ADMIN' || (user?.department?.name ?? '').includes('采购')

  // URL 参数：projectId 过滤（项目详情跳转）+ tab 定位
  const [urlProjectId, setUrlProjectId] = useState('')
  // ★ Step4：项目/供应商下拉筛选（与 URL projectId 合流）
  const [projectFilter, setProjectFilter] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('projectId')
    if (p) {
      setUrlProjectId(p)
      setProjectFilter(p)
    }
  }, [])
  useEffect(() => {
    if (pathname === '/purchase') {
      const p = new URLSearchParams(window.location.search).get('projectId')
      setUrlProjectId(p ?? '')
      if (p) setProjectFilter(p)
    }
  }, [pathname])

  // 订单筛选
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [page, setPage] = useState(1)

  // 弹窗状态
  const [orderFormOpen, setOrderFormOpen] = useState(false)
  const [suppMode, setSuppMode] = React.useState(false)
  const [suppOfId, setSuppOfId] = useState<string | null>(null)
  const [suppProjectId, setSuppProjectId] = useState<string | null>(null)
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [requestFormOpen, setRequestFormOpen] = useState(false)
  // ★ Step4：DRAFT 编辑模式
  const [editOrderId, setEditOrderId] = useState<string | null>(null)
  // Excel 导入（★ 2026-08-25 重构：改为 AI 工作台——乱格式→标准表格→品牌归纳→供应商归单）
  const [wbOpen, setWbOpen] = useState(false)
  // ★ 2026-08-25 项目采购总清单（合并汇总）弹窗
  const [consolidatedOpen, setConsolidatedOpen] = useState(false)
  // ★ 2026-08-25：供应商需求详情/流转弹窗（导入→分解→转订单链路补全）
  const [srDetailId, setSrDetailId] = useState<string | null>(null)
  const [srDetailOpen, setSrDetailOpen] = useState(false)
  // ★ 2026-08-25：SR 多选 + 按供应商归单生成
  const [srSelected, setSrSelected] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  // ★ V3：采购清单「我的清单」筛选（发布人视角）
  const [mineOnly, setMineOnly] = useState(false)

  // ── 跨页定位（useFocusHighlight 约定）：?orderId=/?requestId= → 自动切 tab + 定位高亮 ──
  const { focusId, srcLabel, clearFocus } = useFocusHighlight(['requestId', 'orderId'])
  const [tab, setTab] = useState('orders')
  const [focusKind, setFocusKind] = useState<'order' | 'request' | null>(null)
  const locatedRef = useRef<string | null>(null)
  const pageBeforeLocate = useRef(1)
  useEffect(() => {
    if (!focusId || locatedRef.current === focusId) return
    locatedRef.current = focusId
    const isOrder = !!new URLSearchParams(window.location.search).get('orderId')
    if (!isOrder) {
      // requestId → 采购清单 tab（列表一次拉 50 条无分页 UI）；清掉「我的清单」及残留状态/类别筛选防目标被过滤
      setFocusKind('request')
      setTab('requests')
      setMineOnly(false)
      setStatusFilter('all')
      setCategoryFilter('all')
      return
    }
    // orderId → 订单 tab：清状态/类别/供应商筛选，分块查到所在页（每批100=5页，最多4批=20页）
    setFocusKind('order')
    setTab('orders')
    setStatusFilter('all')
    setCategoryFilter('all')
    setSupplierFilter('')
    pageBeforeLocate.current = page
    let cancelled = false
    ;(async () => {
      try {
        for (let chunk = 1; chunk <= 4; chunk++) {
          const qs = new URLSearchParams({ page: String(chunk), limit: '100' })
          if (urlProjectId) qs.set('projectId', urlProjectId)
          const resp = await ApiService.get<OrdersResp>(`/purchase-orders?${qs}`).then((r) => r.data)
          if (cancelled || !resp) return
          const idx = resp.items.findIndex((o) => o.id === focusId)
          if (idx >= 0) {
            setPage((chunk - 1) * 5 + Math.floor(idx / 20) + 1)
            return
          }
          if (resp.items.length < 100 || chunk >= resp.pagination.pages) break
        }
        if (!cancelled) {
          toast({ title: '未在前20页找到该单据，可能已被删除' })
          setPage(pageBeforeLocate.current) // 找不到恢复原页码，不破坏浏览状态
        }
      } catch {
        /* 定位失败不阻塞正常浏览 */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  // ── ★ 筛选接线：状态筛选值随 Tab 适配——切 Tab 时若当前值不属于目标 Tab 状态集则重置为 all ──
  useEffect(() => {
    const valid =
      tab === 'requests' ? PR_STATUS_FILTERS : tab === 'srs' ? SR_STATUS_FILTERS : ORDER_STATUS_FILTERS
    if (!valid.has(statusFilter)) setStatusFilter('all')
  }, [tab, statusFilter])

  // ── 订单列表（★ Step4：项目下拉筛选值 projectFilter + 供应商 supplierFilter）──
  const ordersQueryStr = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: '20' })
    if (projectFilter) params.set('projectId', projectFilter)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (categoryFilter !== 'all') params.set('category', categoryFilter)
    if (supplierFilter) params.set('supplierId', supplierFilter)
    return params.toString()
  }, [page, projectFilter, statusFilter, categoryFilter, supplierFilter])

  const { data: ordersData, isLoading: ordersLoading } = useQuery({
    queryKey: ['purchase-orders', ordersQueryStr],
    // ★ 聚合组（PENDING/ACTIVE）走 fetchOrdersResp 多状态合并；单状态/全部维持单请求
    queryFn: () => fetchOrdersResp(ordersQueryStr),
  })

  // ── 采购清单列表（★ 筛选接线：项目/状态/类别接入页面筛选；无供应商维度——清单阶段未定供应商）──
  const requestsQueryStr = useMemo(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (projectFilter) params.set('projectId', projectFilter)
    // 防御：跨 Tab 残留的订单状态值（如 PENDING 聚合组）不落入 PR 查询
    if (statusFilter !== 'all' && PR_STATUS_FILTERS.has(statusFilter)) params.set('status', statusFilter)
    if (categoryFilter !== 'all') params.set('category', categoryFilter)
    return params.toString()
  }, [projectFilter, statusFilter, categoryFilter])

  const { data: requestsData, isLoading: requestsLoading } = useQuery({
    queryKey: ['purchase-requests', requestsQueryStr],
    queryFn: () =>
      ApiService.get<{ items: RequestRow[]; pagination: { total: number } }>(
        `/purchase-requests?${requestsQueryStr}`,
      ).then((r) => r.data),
  })

  // ── 供应商需求列表（★ 筛选接线：项目/状态/类别/供应商四维全接）──
  const srQueryStr = useMemo(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (projectFilter) params.set('projectId', projectFilter)
    // 防御：跨 Tab 残留的订单状态值（如 PENDING 聚合组）不落入 SR 查询
    if (statusFilter !== 'all' && SR_STATUS_FILTERS.has(statusFilter)) params.set('status', statusFilter)
    if (categoryFilter !== 'all') params.set('category', categoryFilter)
    if (supplierFilter) params.set('supplierId', supplierFilter)
    return params.toString()
  }, [projectFilter, statusFilter, categoryFilter, supplierFilter])

  const { data: srData, isLoading: srLoading } = useQuery({
    queryKey: ['supplier-requests', srQueryStr],
    queryFn: () =>
      ApiService.get<{ items: SupplierRequestRow[]; pagination: { total: number } }>(
        `/supplier-requests?${srQueryStr}`,
      ).then((r) => r.data),
  })

  // ── ★ Step4：筛选下拉数据源（项目 / 供应商）──
  const { data: projectOptions = [] } = useQuery({
    queryKey: ['purchase-filter-projects'],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; code: string; name: string }> }>(
        '/projects?limit=200',
      ).then((r) => r.data?.items ?? []),
  })
  const { data: supplierOptions = [] } = useQuery({
    queryKey: ['purchase-filter-suppliers'],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; name: string }> }>(
        '/external-orgs?type=SUPPLIER&limit=200',
      ).then((r) => ((r.data as any)?.items ?? (r.data as any) ?? []) as Array<{ id: string; name: string }>),
  })

  // ── ★ 统计卡计数（2026-08-25 改：独立于列表状态筛选，仅随项目过滤变化；API 单 status → 逐状态 limit=1 取 total）──
  //    原先读 ordersData.stats 会随列表 status 筛选联动，卡片数字失真且点击定位判断会误报“暂无”
  const { data: statusCounts } = useQuery({
    queryKey: ['purchase-orders-status-counts', projectFilter],
    queryFn: async () => {
      const statuses = [
        'DRAFT',
        'CONTRACT_PENDING',
        'CONFIRMED',
        'ORDERED',
        'PREPARING',
        'SHIPPED',
        'PARTIAL',
        'COMPLETED',
      ] as const
      const results = await Promise.all(
        statuses.map((s) =>
          ApiService.get<{ pagination: { total: number } }>(
            `/purchase-orders?limit=1&status=${s}${projectFilter ? `&projectId=${projectFilter}` : ''}`,
          )
            .then((r) => r.data?.pagination?.total ?? 0)
            .catch(() => 0),
        ),
      )
      return Object.fromEntries(statuses.map((s, i) => [s, results[i]])) as Record<string, number>
    },
  })

  const stats = ordersData?.stats
  // ★ V3 分组（与 STATUS_GROUPS 同步）：待处理=草稿+待合同+合同确认；进行中=已下单+备货+已发货+部分到货；已完成
  const pendingCount =
    (statusCounts?.DRAFT ?? 0) +
    (statusCounts?.CONTRACT_PENDING ?? 0) +
    (statusCounts?.CONFIRMED ?? 0)
  const activeCount =
    (statusCounts?.ORDERED ?? 0) +
    (statusCounts?.PREPARING ?? 0) +
    (statusCounts?.SHIPPED ?? 0) +
    (statusCounts?.PARTIAL ?? 0)
  const doneCount = statusCounts?.COMPLETED ?? 0

  // ── ★ 统计卡点击定位：设对应状态筛选（聚合组见 STATUS_GROUPS）→ 切订单 Tab → 数据就绪后滚动+闪烁首条 ──
  const [cardFocusToken, setCardFocusToken] = useState<string | null>(null)
  const cardClickSeq = useRef(0) // 自增序号：同卡重复点击也能重新触发定位
  const handleStatCardClick = (group: 'PENDING' | 'ACTIVE' | 'COMPLETED') => {
    const label = group === 'COMPLETED' ? '已完成' : STATUS_GROUPS[group].label
    const count = group === 'PENDING' ? pendingCount : group === 'ACTIVE' ? activeCount : doneCount
    if (count <= 0) {
      toast({ description: `「${label}」分类下暂无订单` })
      return
    }
    setTab('orders')
    setStatusFilter(group === 'COMPLETED' ? 'COMPLETED' : group)
    setPage(1)
    cardClickSeq.current += 1
    setCardFocusToken(`${group}-${cardClickSeq.current}`)
  }
  const openCreate = (supplementary = false) => {
    setSuppMode(supplementary)
    setSuppOfId(null)
    setSuppProjectId(null)
    setEditOrderId(null)
    setOrderFormOpen(true)
  }
  // ★ Step4：详情抽屉「编辑」入口（DRAFT）
  const openEdit = (id: string) => {
    setDetailOpen(false)
    setSuppMode(false)
    setSuppOfId(null)
    setSuppProjectId(null)
    setEditOrderId(id)
    setOrderFormOpen(true)
  }
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
    queryClient.invalidateQueries({ queryKey: ['purchase-requests'] })
    queryClient.invalidateQueries({ queryKey: ['supplier-requests'] })
  }

  // ── ★ 2026-08-25 导出 Excel：订单（按当前筛选拉全量，上限1000）、清单（当前视图）──
  const [exporting, setExporting] = useState(false)
  const exportOrders = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const all: OrderRow[] = []
      // ★ 聚合组（PENDING/ACTIVE）导出：组内逐状态拉取后合并（与列表口径一致）
      const group = STATUS_GROUPS[statusFilter]
      const exportStatuses = group
        ? group.statuses
        : statusFilter !== 'all'
          ? [statusFilter]
          : ['']
      for (const s of exportStatuses) {
        if (all.length >= 1000) break
        for (let p = 1; p <= 50; p++) {
          const params = new URLSearchParams({ page: String(p), limit: '100' })
          if (projectFilter) params.set('projectId', projectFilter)
          if (s) params.set('status', s)
          if (categoryFilter !== 'all') params.set('category', categoryFilter)
          if (supplierFilter) params.set('supplierId', supplierFilter)
          const resp = await ApiService.get<OrdersResp>(`/purchase-orders?${params}`).then((r) => r.data)
          all.push(...(resp?.items ?? []))
          if (!resp || p >= resp.pagination.pages || all.length >= 1000) break
        }
      }
      all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      if (all.length === 0) {
        toast({ description: '当前筛选下没有可导出的订单' })
        return
      }
      await exportPurchaseOrders(
        all.map((o) => ({
          code: o.code,
          title: o.title,
          projectCode: o.project.code,
          projectName: o.project.name,
          categoryLabel: CATEGORY_LABEL[o.category] ?? o.category,
          supplierName: o.supplier?.name ?? null,
          statusLabel: ORDER_STATUS_META[o.status]?.label ?? o.status,
          amount: o.amount != null ? Number(o.amount) : null,
          itemCount: o._count?.items ?? 0,
          arrivalCount: o._count?.arrivals ?? 0,
          plannedArrivalDate: o.plannedArrivalDate ? fmtDate(o.plannedArrivalDate) : null,
          createdAt: fmtDate(o.createdAt),
          ownerName: o.owner?.name ?? null,
          isSupplementary: !!o.isSupplementary,
        })),
      )
      toast({ description: `已导出 ${all.length} 条采购订单` })
    } catch (e: unknown) {
      toast({ title: '导出失败', description: e instanceof Error ? e.message : '', variant: 'destructive' })
    } finally {
      setExporting(false)
    }
  }
  const exportRequests = async () => {
    if (exporting) return
    const list = requestsData?.items ?? []
    const view = mineOnly ? list.filter((pr) => pr.requester?.id === user?.id) : list
    if (view.length === 0) {
      toast({ description: '当前没有可导出的采购清单' })
      return
    }
    setExporting(true)
    try {
      await exportPurchaseRequests(
        view.map((pr) => ({
          code: pr.code,
          title: pr.title,
          projectCode: pr.project.code,
          projectName: pr.project.name,
          statusLabel: PR_STATUS_META[pr.status]?.label ?? pr.status,
          priorityLabel: PRIORITY_LABEL[pr.priority] ?? pr.priority,
          itemCount: pr._count?.items ?? 0,
          srCount: pr._count?.supplierRequests ?? 0,
          expectedArrivalDate: pr.expectedArrivalDate ? fmtDate(pr.expectedArrivalDate) : null,
          requesterName: pr.requester?.name ?? null,
          createdAt: fmtDate(pr.createdAt),
          handlerName: pr.handler?.name ?? null,
          rejectReason: pr.rejectReason,
        })),
      )
      toast({ description: `已导出 ${view.length} 条采购清单` })
    } catch (e: unknown) {
      toast({ title: '导出失败', description: e instanceof Error ? e.message : '', variant: 'destructive' })
    } finally {
      setExporting(false)
    }
  }

  // ── 订单命中行闪烁 3s + 滚动到视口中央（原始 <tr> 无法用 div 版 FocusRing，原生实现）──
  const [flashOrderId, setFlashOrderId] = useState<string | null>(null)
  const orderRowRef = useRef<HTMLTableRowElement>(null)
  const flashedRef = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'orders' || focusKind !== 'order' || !focusId || !ordersData) return
    if (flashedRef.current === focusId) return
    if (!ordersData.items.some((o) => o.id === focusId)) return
    flashedRef.current = focusId
    setFlashOrderId(focusId)
    const raf = requestAnimationFrame(() =>
      orderRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
    const t = setTimeout(() => setFlashOrderId(null), 3000)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [tab, focusKind, focusId, ordersData])

  // ── ★ 统计卡点击定位：列表数据就绪 → 滚动到该分类首条并复用 focus-ring-flash 闪烁 3s ──
  const cardFlashedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!cardFocusToken || tab !== 'orders' || ordersLoading || !ordersData) return
    if (cardFlashedRef.current === cardFocusToken) return
    cardFlashedRef.current = cardFocusToken
    const first = ordersData.items[0]
    if (!first) {
      toast({ description: '该分类在当前筛选范围内暂无订单' })
      return
    }
    setFlashOrderId(first.id)
    const raf = requestAnimationFrame(() =>
      orderRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
    const t = setTimeout(() => setFlashOrderId(null), 3000)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [cardFocusToken, tab, ordersLoading, ordersData, toast])

  // ── 采购清单命中行闪烁 3s + 滚动到视口中央（表格行，与订单 Tab 同款原生实现）──
  const [flashRequestId, setFlashRequestId] = useState<string | null>(null)
  const requestRowRef = useRef<HTMLTableRowElement>(null)
  const reqFlashedRef = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'requests' || focusKind !== 'request' || !focusId || !requestsData) return
    if (reqFlashedRef.current === focusId) return
    if (!requestsData.items.some((pr) => pr.id === focusId)) return
    reqFlashedRef.current = focusId
    setFlashRequestId(focusId)
    const raf = requestAnimationFrame(() =>
      requestRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
    const t = setTimeout(() => setFlashRequestId(null), 3000)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [tab, focusKind, focusId, requestsData])

  // ── 采购清单命中不到时提示一次（列表 limit=50 一次拉全）──
  const reqNotFoundRef = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'requests' || focusKind !== 'request' || !focusId || !requestsData) return
    if (reqNotFoundRef.current === focusId) return
    if (requestsData.items.some((pr) => pr.id === focusId)) return
    reqNotFoundRef.current = focusId
    toast({ title: '未找到该采购清单，可能已被删除' })
  }, [tab, focusKind, focusId, requestsData, toast])

  // ── 删除工程第 6 棒：订单删除（仅 DRAFT；权限终审在服务端 isWriter 双闸）──
  const deleteOrder = (o: OrderRow) => {
    confirm.ask(
      '删除采购订单',
      `将永久删除草稿订单 ${o.code}（${o.title}）及其全部明细，删除后不可恢复，操作将记入审计日志。`,
      async () => {
        try {
          await ApiService.delete(`/purchase-orders/${o.id}`)
          toast({ title: '订单已删除', description: o.code })
          refreshAll()
        } catch (e: unknown) {
          const msg =
            (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
            (e as Error).message
          toast({ title: '删除失败', description: msg, variant: 'destructive' })
        }
      },
      { confirmText: '删除', destructive: true },
    )
  }

  // ── ★ 按供应商归单生成订单（采购模块重构核心交互：一个供应商一张外发订单）──
  const selectableSrs = useMemo(
    () =>
      (srData?.items ?? [])
        .filter((s) => ['PUBLISHED', 'QUOTED'].includes(s.status) && !s.order?.code)
        .map((s) => s.id),
    [srData],
  )
  const generateOrdersFromSrs = () => {
    const ids = Array.from(srSelected)
    if (ids.length === 0 || generating) return
    const chosen = (srData?.items ?? []).filter((s) => srSelected.has(s.id))
    const noSupplier = chosen.filter((s) => !s.supplier?.name)
    if (noSupplier.length > 0) {
      toast({
        title: '部分任务未指定供应商',
        description: `${noSupplier.map((s) => s.code).join('、')} 请先点开任务指定供应商，再勾选生成`,
        variant: 'destructive',
      })
      return
    }
    const bySupplier = new Map<string, number>()
    chosen.forEach((s) => {
      const k = s.supplier?.name ?? '?'
      bySupplier.set(k, (bySupplier.get(k) ?? 0) + 1)
    })
    confirm.ask(
      '按供应商生成采购订单',
      `将把 ${ids.length} 个任务按供应商归纳，生成 ${bySupplier.size} 张采购订单（草稿起步）：\n${Array.from(bySupplier.entries()).map(([n, c]) => `· ${n}：${c} 个任务`).join('\n')}\n\n确认生成？`,
      async () => {
        setGenerating(true)
        try {
          const res = await ApiService.post<{
            orders: Array<{ id: string; code: string; supplierName: string }>
          }>('/purchase-orders/generate', { supplierRequestIds: ids }, { timeout: 60_000 })
          toast({
            title: res.message ?? '已生成采购订单',
            description: (res.data?.orders ?? []).map((o) => `${o.code}（${o.supplierName}）`).join('、'),
          })
          setSrSelected(new Set())
          refreshAll()
        } catch (e: unknown) {
          const msg =
            (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
            (e as Error).message
          toast({ title: '生成失败', description: msg, variant: 'destructive' })
        } finally {
          setGenerating(false)
        }
      },
      { confirmText: '生成订单' },
    )
  }

  // ── 删除工程第 6 棒：供应商需求删除（DRAFT/CANCELLED；权限终审在服务端创建人/采购部闸）──
  const deleteSupplierRequest = (sr: SupplierRequestRow) => {
    confirm.ask(
      '删除供应商需求',
      `将永久删除 ${sr.code}${sr.title ? `（${sr.title}）` : ''} 及其物料明细，删除后不可恢复，操作将记入审计日志。`,
      async () => {
        try {
          await ApiService.delete(`/supplier-requests/${sr.id}`)
          toast({ title: '供应商需求已删除', description: sr.code })
          refreshAll()
        } catch (e: unknown) {
          const msg =
            (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
            (e as Error).message
          toast({ title: '删除失败', description: msg, variant: 'destructive' })
        }
      },
      { confirmText: '删除', destructive: true },
    )
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">采购订单</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            采购清单 → 分解发需求 → 下单 → 到货清点，全流程管理
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openCreate(false)}>
            <Plus className="mr-1 h-4 w-4" /> 新建订单
          </Button>
          <Button size="sm" variant="outline" onClick={() => openCreate(true)}>
            <Plus className="mr-1 h-4 w-4" /> 追加采购
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRequestFormOpen(true)}>
            <ClipboardList className="mr-1 h-4 w-4" /> 提需求
          </Button>
          <Button size="sm" onClick={() => setWbOpen(true)}>
            <Sparkles className="mr-1 h-4 w-4" /> AI 导入清单
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConsolidatedOpen(true)}>
            <FileStack className="mr-1 h-4 w-4" /> 项目总清单
          </Button>
        </div>
      </div>

      {/* 定位来源提示条：URL 带 src 时显示，可关闭 */}
      {srcLabel && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 font-normal">
            已定位 · 来自：{srcLabel}
            <button
              type="button"
              onClick={clearFocus}
              className="ml-0.5 text-muted-foreground hover:text-foreground"
              aria-label="关闭定位提示"
            >
              ✕
            </button>
          </Badge>
        </div>
      )}

      {/* 统计卡（★ V3 新分组；★ 2026-08-25 前三卡可点击：设状态筛选+滚动定位到列表首条，金额卡不可点） */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            { title: '待处理（草稿/待合同/合同确认）', value: pendingCount, icon: Clock, tone: 'text-amber-500', group: 'PENDING' },
            { title: '进行中（下单/备货/发货/部分到货）', value: activeCount, icon: ShoppingCart, tone: 'text-blue-500', group: 'ACTIVE' },
            { title: '已完成', value: doneCount, icon: CheckCircle2, tone: 'text-emerald-500', group: 'COMPLETED' },
          ] as const
        ).map(({ title, value, icon: Icon, tone, group }) => (
          <Card
            key={title}
            role="button"
            tabIndex={0}
            title="点击按该状态筛选并定位到列表首条"
            aria-label={`点击查看${title}的订单`}
            onClick={() => handleStatCardClick(group)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleStatCardClick(group)
              }
            }}
            className="group cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs text-muted-foreground">{title}</p>
                <p className="mt-1 text-2xl font-semibold">{value}</p>
              </div>
              <div className="relative">
                <Icon className={cn('h-8 w-8 opacity-60', tone)} />
                {/* 可点击暗示：hover 时图标角落浮现小箭头 */}
                <span className="absolute -bottom-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  <ChevronRight className="h-3 w-3" />
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs text-muted-foreground">本月金额</p>
              <p className="mt-1 text-xl font-semibold font-mono">
                {fmtMoney(stats?.monthAmount ?? null)}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                累计总 {fmtMoney(stats?.totalAmount ?? null)}
              </p>
            </div>
            <DollarSign className="h-8 w-8 text-amber-500 opacity-60" />
          </CardContent>
        </Card>
      </div>

      {/* 筛选行（★ Step4：项目/状态/类别/供应商四维筛选） */}
      <div className="flex flex-wrap items-center gap-2">
        {urlProjectId && (
          <Badge variant="outline" className="gap-1 font-normal">
            按项目过滤
            <button
              type="button"
              onClick={() => {
                setUrlProjectId('')
                setProjectFilter('')
                setPage(1)
                router.replace('/purchase')
              }}
              className="ml-0.5 text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </Badge>
        )}
        <Select
          value={projectFilter}
          onValueChange={(v) => {
            setProjectFilter(v === 'all' ? '' : v)
            setPage(1)
            if (v === 'all' && urlProjectId) {
              setUrlProjectId('')
              router.replace('/purchase')
            }
          }}
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue placeholder="全部项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部项目</SelectItem>
            {projectOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.code} · {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {/* ★ 状态选项随 Tab 适配：订单=聚合组+九状态；采购清单=PR 状态集；供应商需求=SR 状态集 */}
            {tab === 'requests'
              ? Object.entries(PR_STATUS_META).map(([v, m]) => (
                  <SelectItem key={v} value={v}>
                    {m.label}
                  </SelectItem>
                ))
              : tab === 'srs'
                ? Object.entries(SR_STATUS_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))
                : (
                  <>
                    {/* ★ 与统计卡一致的状态聚合组（点击统计卡即设为这两个值） */}
                    {Object.entries(STATUS_GROUPS).map(([v, g]) => (
                      <SelectItem key={v} value={v}>
                        {g.label}
                      </SelectItem>
                    ))}
                    {Object.entries(ORDER_STATUS_META).map(([v, m]) => (
                      <SelectItem key={v} value={v}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </>
                )}
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(v) => {
            setCategoryFilter(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类别</SelectItem>
            {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 供应商筛选（★ 采购清单 Tab 不适用——清单阶段未定供应商，隐藏；订单/供应商需求两 Tab 共用） */}
        {tab !== 'requests' && (
          <Select
            value={supplierFilter}
            onValueChange={(v) => {
              setSupplierFilter(v === 'all' ? '' : v)
              setPage(1)
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="全部供应商" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部供应商</SelectItem>
              {supplierOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* 三 Tab */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="orders">采购订单</TabsTrigger>
          <TabsTrigger value="requests">采购清单</TabsTrigger>
          <TabsTrigger value="srs">供应商需求</TabsTrigger>
        </TabsList>

        {/* ── Tab1 采购订单 ── */}
        <TabsContent value="orders" className="mt-3 space-y-3">
          {ordersLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !ordersData || ordersData.items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              暂无采购订单，点击右上角「新建订单」开始
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">编号</th>
                      <th className="px-3 py-2 font-medium">标题</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">项目</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">类别</th>
                      <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">供应商</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">金额</th>
                      <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">计划到货</th>
                      <th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordersData.items.map((o) => {
                      const meta = ORDER_STATUS_META[o.status] ?? { label: o.status, cls: '' }
                      return (
                        <tr
                          key={o.id}
                          ref={o.id === flashOrderId ? orderRowRef : undefined}
                          data-focus-id={o.id === focusId ? o.id : undefined}
                          className={cn(
                            'cursor-pointer border-t transition-colors hover:bg-muted/40',
                            o.id === flashOrderId && 'focus-ring-flash',
                          )}
                          onClick={() => {
                            setDetailOrderId(o.id)
                            setDetailOpen(true)
                          }}
                        >
                          <td className="whitespace-nowrap px-3 py-2">
                            <span className="font-mono text-xs font-semibold">{o.code}</span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              <span className="max-w-[16em] truncate text-xs">{o.title}</span>
                              {o.isSupplementary && (
                                <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
                                  追加
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs">
                            <span className="font-mono text-primary">{o.project.code}</span>
                            <span className="ml-1 text-muted-foreground">{o.project.name}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <Badge variant="outline" className="text-[10px]">
                              {CATEGORY_LABEL[o.category] ?? o.category}
                            </Badge>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">{o.supplier?.name ?? '—'}</td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <Badge className={cn('text-xs', meta.cls)}>{meta.label}</Badge>
                          </td>
                          <td className="hidden px-3 py-2 text-right font-mono text-xs sm:table-cell">
                            {fmtMoney(o.amount)}
                          </td>
                          <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                            {fmtDate(o.plannedArrivalDate)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {o.status === 'DRAFT' &&
                            (isPurchase || o.creator?.id === user?.id || o.owner?.id === user?.id) ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  deleteOrder(o)
                                }}
                              >
                                <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <TablePagination
                page={page}
                pages={ordersData.pagination.pages}
                total={ordersData.pagination.total}
                onPageChange={setPage}
              />
              <div className="flex justify-end">
                <Button size="sm" variant="outline" className="h-7" onClick={exportOrders} disabled={exporting}>
                  <FileDown className="mr-1 h-3.5 w-3.5" /> 导出Excel（按当前筛选）
                </Button>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Tab2 采购清单（★ 2026-08-25 改为表格样式：信息与原卡片版一一对应，功能不减）── */}
        <TabsContent value="requests" className="mt-3">
          <div className="mb-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant={mineOnly ? 'default' : 'outline'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setMineOnly((v) => !v)}
            >
              <UserRound className="mr-1 h-3.5 w-3.5" /> 我的清单
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={exportRequests} disabled={exporting}>
              <FileDown className="mr-1 h-3.5 w-3.5" /> 导出Excel
            </Button>
          </div>
          {requestsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !requestsData || requestsData.items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              暂无采购清单，点击右上角「提需求」发起
            </div>
          ) : (
            (() => {
              const filtered = mineOnly
                ? requestsData.items.filter((pr) => pr.requester?.id === user?.id)
                : requestsData.items
              if (filtered.length === 0) {
                return (
                  <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    没有你发布的采购清单；点右上角「提需求」发起，或取消「我的清单」筛选查看全部
                  </div>
                )
              }
              return (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">编号</th>
                        <th className="px-3 py-2 font-medium">标题</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">项目</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">状态</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 text-right font-medium md:table-cell">物料</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 text-right font-medium md:table-cell">分解</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 font-medium sm:table-cell">期望到货</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">提出人</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">提交日期</th>
                        <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">经办人</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((pr) => {
                        const meta = PR_STATUS_META[pr.status] ?? { label: pr.status, cls: '' }
                        return (
                          <tr
                            key={pr.id}
                            ref={pr.id === flashRequestId ? requestRowRef : undefined}
                            data-focus-id={pr.id === focusId ? pr.id : undefined}
                            className={cn(
                              'border-t transition-colors hover:bg-muted/40',
                              pr.id === flashRequestId && 'focus-ring-flash',
                            )}
                          >
                            <td className="whitespace-nowrap px-3 py-2">
                              <span className="font-mono text-xs font-semibold">{pr.code}</span>
                            </td>
                            <td className="max-w-[20em] px-3 py-2">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-xs">{pr.title}</span>
                                {pr.priority === 'URGENT' && (
                                  <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
                                    紧急
                                  </Badge>
                                )}
                              </div>
                              {pr.status === 'REJECTED' && pr.rejectReason && (
                                <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                                  驳回原因:{pr.rejectReason}
                                </p>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs">
                              <span className="font-mono text-primary">{pr.project.code}</span>
                              <span className="ml-1 text-muted-foreground">{pr.project.name}</span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <Badge className={cn('text-xs', meta.cls)}>{meta.label}</Badge>
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground md:table-cell">
                              {pr._count.items} 项
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground md:table-cell">
                              {pr._count.supplierRequests > 0 ? `${pr._count.supplierRequests} 个` : '—'}
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                              {fmtDate(pr.expectedArrivalDate)}
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs lg:table-cell">
                              {pr.requester?.name ?? '—'}
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                              {fmtDate(pr.createdAt)}
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs lg:table-cell">
                              {pr.handler?.name ?? '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            })()
          )}
        </TabsContent>

        {/* ── Tab3 供应商需求（★ 2026-08-25：多选 + 按供应商归单生成订单）── */}
        <TabsContent value="srs" className="mt-3">
          {isPurchase && srData && srData.items.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                勾选任务（需已指定供应商）→ 按供应商自动归纳，每个供应商生成一张采购订单
              </p>
              <Button
                size="sm"
                className="h-7"
                disabled={srSelected.size === 0 || generating}
                onClick={generateOrdersFromSrs}
              >
                {generating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ListChecks className="mr-1 h-3.5 w-3.5" />}
                按供应商生成订单（已选 {srSelected.size}）
              </Button>
            </div>
          )}
          {srLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !srData || srData.items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              暂无供应商需求；在采购清单受理后分解生成，或由采购直接创建
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    {isPurchase && (
                      <th className="w-9 px-2 py-2">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={selectableSrs.length > 0 && srSelected.size === selectableSrs.length}
                          onChange={(e) =>
                            setSrSelected(e.target.checked ? new Set(selectableSrs) : new Set())
                          }
                        />
                      </th>
                    )}
                    <th className="px-3 py-2 font-medium">编号</th>
                    <th className="px-3 py-2 font-medium">来源清单</th>
                    <th className="px-3 py-2 font-medium">供应商</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">报价额</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">关联订单</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {srData.items.map((sr) => (
                    <tr
                      key={sr.id}
                      className={cn(
                        'cursor-pointer border-t transition-colors hover:bg-muted/40',
                        srSelected.has(sr.id) && 'bg-primary/5',
                      )}
                      onClick={() => {
                        setSrDetailId(sr.id)
                        setSrDetailOpen(true)
                      }}
                    >
                      {isPurchase && (
                        <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                          {['PUBLISHED', 'QUOTED'].includes(sr.status) && !sr.order?.code ? (
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={srSelected.has(sr.id)}
                              onChange={(e) =>
                                setSrSelected((prev) => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(sr.id)
                                  else next.delete(sr.id)
                                  return next
                                })
                              }
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground" />
                          )}
                        </td>
                      )}
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">{sr.code}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {sr.request ? (
                          <span className="font-mono text-primary">{sr.request.code}</span>
                        ) : (
                          <span className="text-muted-foreground">独立发起</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{sr.supplier?.name ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{SR_STATUS_LABEL[sr.status] ?? sr.status}</td>
                      <td className="hidden px-3 py-2 text-right font-mono text-xs sm:table-cell">
                        {fmtMoney(sr.quoteAmount)}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2 font-mono text-xs md:table-cell">
                        {sr.order?.code ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {(sr.status === 'DRAFT' || sr.status === 'CANCELLED') &&
                        (isPurchase || sr.creator?.id === user?.id) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteSupplierRequest(sr)
                            }}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* 弹窗 */}
      <OrderFormDialog
        open={orderFormOpen}
        onOpenChange={setOrderFormOpen}
        supplementary={suppMode}
        supplementaryOfId={suppOfId}
        defaultProjectId={suppProjectId ?? (urlProjectId || null)}
        editOrderId={editOrderId}
        onCreated={refreshAll}
      />
      <OrderDetailDialog
        orderId={detailOrderId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onChanged={refreshAll}
        onEdit={openEdit}
        onSupplement={(ofId, projectId) => {
          setDetailOpen(false)
          setSuppMode(true)
          setSuppOfId(ofId)
          setSuppProjectId(projectId)
          setEditOrderId(null)
          setOrderFormOpen(true)
        }}
      />
      <RequestFormDialog
        open={requestFormOpen}
        onOpenChange={setRequestFormOpen}
        defaultProjectId={urlProjectId || null}
        onCreated={refreshAll}
      />
      {/* ★ AI 采购工作台：乱格式清单 → 标准表格 → 品牌归纳 → 指定供应商 → 按供应商归单生成订单 */}
      <AiPurchaseWorkbench
        open={wbOpen}
        onOpenChange={setWbOpen}
        projectId={urlProjectId || ''}
        onImported={refreshAll}
        onViewOrder={(orderId) => {
          setTab('orders')
          setDetailOrderId(orderId)
          setDetailOpen(true)
        }}
      />
      {/* ★ 2026-08-25 项目采购总清单：全订单明细按三大类合并汇总，阶段性/结项归档/成本核算 */}
      <ConsolidatedListDialog
        open={consolidatedOpen}
        onOpenChange={setConsolidatedOpen}
        defaultProjectId={urlProjectId || null}
      />
      {/* ★ 供应商需求详情/流转：报价 → 转订单（自动生成 CG-* 草稿订单）；查看订单跳订单 Tab */}
      <SupplierRequestDetailDialog
        srId={srDetailId}
        open={srDetailOpen}
        onOpenChange={setSrDetailOpen}
        onChanged={refreshAll}
        onViewOrder={(orderId) => {
          setSrDetailOpen(false)
          setTab('orders')
          setDetailOrderId(orderId)
          setDetailOpen(true)
        }}
      />
      {confirm.render}
    </div>
  )
}

export default function PurchasePage() {
  return (
    <PageGuard pageKey="purchase">
      {/* useFocusHighlight 内部用 useSearchParams，静态预渲染需 Suspense 包裹 */}
      <Suspense fallback={null}>
        <PurchasePageInner />
      </Suspense>
    </PageGuard>
  )
}
