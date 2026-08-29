'use client'

/**
 * /views/charts —— 图表视图（ChartsView，P3 交付）
 *
 * 依据《开发文档-项目管理系统重构》§8.2⑤：
 *   ChartsView: recharts —— 项目状态环图 / 20阶段漏斗 / 人员负载条形 / 文件及时率线 / 回款进度条
 *
 * 数据源：GET /api/analytics/overview[?projectId=]（§7.9）
 *   data = { projectStatusDist, phaseFunnel, memberLoad, fileTimeliness, paymentProgress }
 *   - 未选项目 → 不带 projectId 的全局 analytics；选了项目 → 带 projectId 的单项目 analytics
 *   - paymentProgress 为降级口径（回款字段缺失 → 合同金额维度），note 如实标注
 *
 * 视图契约：顶部挂 <ProjectViewPicker />（读 ?projectId=）。
 * ⚠️ useSearchParams 须 <Suspense> 包裹（Next.js 预渲染约束）。
 */

import { Suspense, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BarChart3, AlertTriangle } from 'lucide-react'

import { ProjectViewPicker } from '@/components/views/project-view-picker'
import { PageGuard } from '@/components/layout/page-guard'
import { api } from '@/services/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// ───────────────────────────── 类型 ─────────────────────────────

interface StatusDistItem {
  status: string
  count: number
}
interface FunnelItem {
  code: string
  name: string
  status: string
  projectCount: number
}
interface MemberLoadItem {
  userId: string
  name: string
  taskTotal: number
  taskDone: number
  taskActive: number
}
interface TimelinessItem {
  label: string
  total: number
  onTime: number
}
interface PaymentItem {
  projectId: string
  name: string
  amount: number | null
  status: string
}
interface PaymentSummaryItem {
  status: string
  projectCount: number
  amount: number | null
}

interface AnalyticsData {
  projectStatusDist: StatusDistItem[]
  phaseFunnel: FunnelItem[]
  memberLoad: MemberLoadItem[]
  fileTimeliness: TimelinessItem[]
  paymentProgress: {
    note: string
    items: PaymentItem[]
    summary: PaymentSummaryItem[]
  }
}

// ───────────────────────────── 常量 ─────────────────────────────

/** 项目状态（§7.9 固定四枚举）→ 中文/颜色 */
const PROJECT_STATUS_META: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: '进行中', color: '#3b82f6' },
  ON_HOLD: { label: '挂起', color: '#f59e0b' },
  COMPLETED: { label: '已完成', color: '#10b981' },
  CANCELLED: { label: '已取消', color: '#ef4444' },
}

/** 阶段状态 → 中文/颜色（漏斗堆叠用） */
const PHASE_STATUS_META: Record<string, { label: string; color: string }> = {
  NOT_STARTED: { label: '未开始', color: '#94a3b8' },
  IN_PROGRESS: { label: '进行中', color: '#3b82f6' },
  PAUSED: { label: '已暂停', color: '#f59e0b' },
  SKIPPED: { label: '已跳过', color: '#eab308' },
  DONE: { label: '已完成', color: '#10b981' },
}

/** 漏斗堆叠状态顺序（DONE 置首 → 已完成从左往右，其余状态依次向右堆叠） */
const PHASE_STATUS_KEYS = ['DONE', 'SKIPPED', 'PAUSED', 'IN_PROGRESS', 'NOT_STARTED'] as const

const statusLabel = (s: string) => PROJECT_STATUS_META[s]?.label ?? s
const statusColor = (s: string) => PROJECT_STATUS_META[s]?.color ?? '#94a3b8'

// ───────────────────────────── 图表卡片骨架 ─────────────────────────────

function ChartCard({
  title,
  description,
  height = 300,
  children,
}: {
  title: string
  description?: string
  height?: number
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div style={{ width: '100%', height }}>{children}</div>
      </CardContent>
    </Card>
  )
}

// ───────────────────────────── 主内容 ─────────────────────────────

function ChartsView() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'overview', projectId || 'global'],
    queryFn: async (): Promise<AnalyticsData> => {
      const res = await api.get('/analytics/overview', {
        params: projectId ? { projectId } : undefined,
      })
      const body = res.data as { data?: AnalyticsData }
      return (
        body?.data ?? {
          projectStatusDist: [],
          phaseFunnel: [],
          memberLoad: [],
          fileTimeliness: [],
          paymentProgress: { note: '', items: [], summary: [] },
        }
      )
    },
  })

  // ── 1. 项目状态环图 ──
  const statusDistData = useMemo(
    () =>
      (data?.projectStatusDist ?? []).map((d) => ({
        name: statusLabel(d.status),
        value: d.count,
        color: statusColor(d.status),
      })),
    [data]
  )

  // ── 2. 20 阶段漏斗（按 code 排序 + 状态堆叠）──
  const funnelData = useMemo(() => {
    const map = new Map<string, { code: string; name: string; counts: Record<string, number> }>()
    for (const f of data?.phaseFunnel ?? []) {
      let e = map.get(f.code)
      if (!e) {
        e = { code: f.code, name: f.name, counts: {} }
        map.set(f.code, e)
      }
      e.counts[f.status] = (e.counts[f.status] ?? 0) + f.projectCount
    }
    return Array.from(map.values())
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((e) => ({
        code: e.code,
        name: e.name,
        NOT_STARTED: e.counts.NOT_STARTED ?? 0,
        IN_PROGRESS: e.counts.IN_PROGRESS ?? 0,
        PAUSED: e.counts.PAUSED ?? 0,
        SKIPPED: e.counts.SKIPPED ?? 0,
        DONE: e.counts.DONE ?? 0,
      }))
  }, [data])

  // ── 3. 人员负载 ──
  const memberData = useMemo(() => data?.memberLoad ?? [], [data])

  // ── 4. 文件及时率（y = onTime/total）──
  const timelinessData = useMemo(
    () =>
      (data?.fileTimeliness ?? []).map((t) => ({
        ...t,
        rate: t.total > 0 ? Number(((t.onTime / t.total) * 100).toFixed(1)) : 0,
      })),
    [data]
  )

  // ── 5. 回款进度（降级：合同金额维度）──
  // 图表数据：amount 为 null（无财务权限脱敏）时显示 0（仅图表展示，不泄露金额）
  const paymentSummaryData = useMemo(
    () =>
      (data?.paymentProgress?.summary ?? []).map((s) => ({
        name: statusLabel(s.status),
        amount: s.amount ?? 0,
        projectCount: s.projectCount,
      })),
    [data]
  )
  const paymentItems = useMemo(() => data?.paymentProgress?.items ?? [], [data])
  const paymentNote = data?.paymentProgress?.note ?? ''

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-72 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 1. 项目状态环图 */}
      <ChartCard
        title="项目状态分布"
        description={projectId ? '当前项目状态' : '全部可见项目状态分布'}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={statusDistData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={95}
              paddingAngle={2}
              label={(entry) => `${entry.name} ${entry.value}`}
            >
              {statusDistData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 2. 20 阶段漏斗 */}
      <ChartCard
        title="阶段漏斗（20 阶段）"
        description="各阶段状态分布（按阶段编号排序，堆叠展示项目数）"
        height={Math.max(360, funnelData.length * 28 + 60)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={funnelData}
            layout="vertical"
            margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="code"
              width={52}
              interval={0}
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                value,
                PHASE_STATUS_META[name]?.label ?? name,
              ]}
            />
            <Legend
              formatter={(value) => PHASE_STATUS_META[value]?.label ?? value}
            />
            {PHASE_STATUS_KEYS.map((k) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="funnel"
                fill={PHASE_STATUS_META[k].color}
                radius={k === 'DONE' ? [3, 0, 0, 3] : undefined}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 3. 人员负载 */}
      <ChartCard
        title="人员负载"
        description="每人任务总数 / 进行中 / 已完成"
        height={Math.max(260, memberData.length * 44 + 60)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={memberData}
            layout="vertical"
            margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="name"
              width={90}
              tick={{ fontSize: 12 }}
            />
            <Tooltip />
            <Legend />
            <Bar dataKey="taskTotal" name="任务总数" stackId="load" fill="#94a3b8" />
            <Bar dataKey="taskActive" name="进行中" stackId="load" fill="#3b82f6" />
            <Bar dataKey="taskDone" name="已完成" stackId="load" fill="#10b981" />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 4. 文件及时率 */}
      <ChartCard
        title="文件及时率"
        description="按应交付月份：柱=文件总数，线=及时率（按时通过占比 %）"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={timelinessData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="count" allowDecimals={false} />
            <YAxis
              yAxisId="rate"
              orientation="right"
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              formatter={(value: number, name: string) =>
                name === '及时率' ? [`${value}%`, name] : [value, name]
              }
            />
            <Legend />
            <Bar yAxisId="count" dataKey="total" name="文件总数" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="rate"
              name="及时率"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 5. 回款进度（降级口径） */}
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-5 w-5" />
              回款进度
            </CardTitle>
            <CardDescription>按项目状态汇总合同金额（回款字段缺失的降级口径）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {paymentNote && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <span className="font-medium">口径说明：</span>
                  {paymentNote}
                </span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={paymentSummaryData}
                    margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip
                      formatter={(value: number, name: string) =>
                        name === '合同金额' ? [`¥${value.toLocaleString()}`, name] : [value, name]
                      }
                    />
                    <Legend />
                    <Bar dataKey="amount" name="合同金额" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* 逐项目明细 */}
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full caption-bottom text-sm">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr className="border-b text-left">
                      <th className="px-3 py-2 font-medium text-muted-foreground">项目</th>
                      <th className="px-3 py-2 font-medium text-muted-foreground">状态</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">合同金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentItems.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">
                          暂无项目数据
                        </td>
                      </tr>
                    ) : (
                      paymentItems.map((p) => (
                        <tr key={p.projectId} className="border-b last:border-0">
                          <td className="px-3 py-2">{p.name}</td>
                          <td className="px-3 py-2">
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: statusColor(p.status) }}
                            />
                            <span className="ml-1.5 text-xs">{statusLabel(p.status)}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {p.amount == null ? '—' : `¥${p.amount.toLocaleString()}`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ───────────────────────────── 页面出口 ─────────────────────────────

export default function ChartsViewPage() {
  return (
    <PageGuard pageKey="charts">
      <div className="space-y-6">
      <Suspense fallback={<div className="h-10 animate-pulse rounded bg-muted" />}>
        <ProjectViewPicker />
      </Suspense>
      <Suspense fallback={<div className="h-72 animate-pulse rounded bg-muted" />}>
        <ChartsView />
      </Suspense>
      </div>
    </PageGuard>
  )
}
