'use client'

/**
 * /purchase —— 采购管理主页（2026-08-22 采购模块 Step 3）
 *
 * 三个 Tab：采购订单 | 采购清单（成员提需求）| 供应商需求
 * 统计卡：待下单 / 进行中 / 已完成 / 总金额（无财务权限显示 —）
 * 权限：PageGuard pageKey='purchase'；采购部身份由 department.name 判定
 */

import { PageGuard } from '@/components/layout/page-guard'
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusHighlight } from '@/hooks/use-focus-highlight'
import { FocusRing } from '@/components/ui/focus-ring'
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
  Loader2,
  Plus,
  CheckCircle2,
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
import { PurchaseImportDialog } from '@/components/purchase/purchase-import-dialog'

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
  creator?: { id: string } | null
  owner?: { id: string } | null
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
  // Excel 导入（2026-08-22：上传→自动分解）
  const [importOpen, setImportOpen] = useState(false)
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
      // requestId → 采购清单 tab（列表一次拉 50 条无分页 UI）；清掉「我的清单」筛选防目标被藏
      setFocusKind('request')
      setTab('requests')
      setMineOnly(false)
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
    queryFn: () => ApiService.get<OrdersResp>(`/purchase-orders?${ordersQueryStr}`).then((r) => r.data),
  })

  // ── 采购清单列表 ──
  const { data: requestsData, isLoading: requestsLoading } = useQuery({
    queryKey: ['purchase-requests', urlProjectId],
    queryFn: () =>
      ApiService.get<{ items: RequestRow[]; pagination: { total: number } }>(
        `/purchase-requests?limit=50${urlProjectId ? `&projectId=${urlProjectId}` : ''}`,
      ).then((r) => r.data),
  })

  // ── 供应商需求列表 ──
  const { data: srData, isLoading: srLoading } = useQuery({
    queryKey: ['supplier-requests', urlProjectId],
    queryFn: () =>
      ApiService.get<{ items: SupplierRequestRow[]; pagination: { total: number } }>(
        `/supplier-requests?limit=50${urlProjectId ? `&projectId=${urlProjectId}` : ''}`,
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

  // ── ★ V3 新状态计数（后端 stats 未含新状态，前端轻量补查：limit=1 取 total）──
  const { data: v3Counts } = useQuery({
    queryKey: ['purchase-orders-v3-counts', projectFilter],
    queryFn: async () => {
      const statuses = ['CONTRACT_PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED'] as const
      const results = await Promise.all(
        statuses.map((s) =>
          ApiService.get<{ pagination: { total: number } }>(
            `/purchase-orders?limit=1&status=${s}${projectFilter ? `&projectId=${projectFilter}` : ''}`,
          )
            .then((r) => r.data?.pagination?.total ?? 0)
            .catch(() => 0),
        ),
      )
      return {
        contractPending: results[0],
        confirmed: results[1],
        preparing: results[2],
        shipped: results[3],
      }
    },
  })

  const stats = ordersData?.stats
  // ★ V3 分组：待处理=草稿+待合同+合同确认；进行中=已下单+备货+已发货+部分到货；已完成
  const pendingCount =
    (stats?.draft ?? 0) + (v3Counts?.contractPending ?? 0) + (v3Counts?.confirmed ?? 0)
  const activeCount =
    (stats?.inTransit ?? 0) + (v3Counts?.preparing ?? 0) + (v3Counts?.shipped ?? 0)
  const doneCount = stats?.completed ?? 0
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
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <FileSpreadsheet className="mr-1 h-4 w-4" /> 导入Excel
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

      {/* 统计卡（★ V3 新分组） */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            { title: '待处理（草稿/待合同/合同确认）', value: pendingCount, icon: Clock, tone: 'text-amber-500' },
            { title: '进行中（下单/备货/发货/部分到货）', value: activeCount, icon: ShoppingCart, tone: 'text-blue-500' },
            { title: '已完成', value: doneCount, icon: CheckCircle2, tone: 'text-emerald-500' },
          ] as const
        ).map(({ title, value, icon: Icon, tone }) => (
          <Card key={title}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs text-muted-foreground">{title}</p>
                <p className="mt-1 text-2xl font-semibold">{value}</p>
              </div>
              <Icon className={cn('h-8 w-8 opacity-60', tone)} />
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
            {Object.entries(ORDER_STATUS_META).map(([v, m]) => (
              <SelectItem key={v} value={v}>
                {m.label}
              </SelectItem>
            ))}
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
            </>
          )}
        </TabsContent>

        {/* ── Tab2 采购清单 ── */}
        <TabsContent value="requests" className="mt-3">
          <div className="mb-2 flex items-center justify-end">
            <Button
              size="sm"
              variant={mineOnly ? 'default' : 'outline'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setMineOnly((v) => !v)}
            >
              <UserRound className="mr-1 h-3.5 w-3.5" /> 我的清单
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
            <div className="space-y-2">
              {(() => {
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
                return filtered.map((pr) => {
                const meta = PR_STATUS_META[pr.status] ?? { label: pr.status, cls: '' }
                return (
                  <FocusRing key={pr.id} id={pr.id} focusId={tab === 'requests' ? focusId : null}>
                  <div className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{pr.code}</span>
                      <span className="text-sm font-medium">{pr.title}</span>
                      <Badge className={cn('text-xs', meta.cls)}>{meta.label}</Badge>
                      {pr.priority === 'URGENT' && (
                        <Badge variant="destructive" className="text-[10px]">
                          紧急
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {pr.requester.name} 提于 {fmtDate(pr.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        <span className="font-mono text-primary">{pr.project.code}</span> {pr.project.name}
                      </span>
                      <span>{pr._count.items} 项物料</span>
                      {pr._count.supplierRequests > 0 && <span>已分解 {pr._count.supplierRequests} 个需求</span>}
                      {pr.expectedArrivalDate && <span>期望 {fmtDate(pr.expectedArrivalDate)}</span>}
                      {pr.handler && <span>经办：{pr.handler.name}</span>}
                    </div>
                    {pr.status === 'REJECTED' && pr.rejectReason && (
                      <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-400">
                        驳回原因:{pr.rejectReason}
                      </p>
                    )}
                  </div>
                  </FocusRing>
                )
                })
              })()}
            </div>
          )}
        </TabsContent>

        {/* ── Tab3 供应商需求 ── */}
        <TabsContent value="srs" className="mt-3">
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
                    <tr key={sr.id} className="border-t">
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
                            onClick={() => deleteSupplierRequest(sr)}
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
      <PurchaseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={urlProjectId || ''}
        onImported={refreshAll}
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
