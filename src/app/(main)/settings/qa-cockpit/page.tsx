'use client'

/**
 * ★ B5-质检驾驶舱（2026-08-25 QA 战役收官沉淀）
 *
 * 系统管理子页：管理员一键跑六维健康检查（页面可达/权限矩阵/项目链/交付催办链/IM链/采购链）、
 * 浏览问题台账、查看历史体检记录。数据源：GET /api/admin/qa-cockpit。
 *
 * 交互约定：
 *  - 「一键体检」逐维度串行 POST（每维完成即刷新卡片状态灯），全部完成 toast 总结
 *  - 重复点击防抖（running 状态）；后端另有内存锁（并发 POST 返回 409）
 *  - 仅 ADMIN 可见（同 settings 页权限策略）
 */

import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  Activity, ShieldCheck, FolderKanban, FileCheck2, MessageSquare, ShoppingCart,
  PlayCircle, RefreshCw, History, ClipboardList, Loader2,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { useAuthStore } from '@/store/auth'

// ── 类型 ──
interface QaIssue {
  id: string
  level: 'P0' | 'P1' | 'P2' | 'P3'
  title: string
  location: string
  status: '登记' | '修复中' | '已验证'
  batch: string
}
interface DimResult { exitCode: number; tail: string; durationMs: number }
interface QaRun {
  id: string
  startedAt: string
  durationMs: number
  triggeredBy: string
  base: string
  dims: Record<string, DimResult>
  okDims: number
  totalDims: number
}
interface CockpitData {
  issues: QaIssue[]
  runs: QaRun[] // 最新在前，≤10 条
  summary: { p0: number; p1: number; p2: number; p3: number; openCount: number; verifiedCount: number }
}

// ── 六维度定义（key 与后端脚本映射一致，勿随意改名）──
const DIMS = [
  { key: 'smoke', name: '页面可达', icon: Activity, desc: '23 页面冒烟' },
  { key: 'perm', name: '权限矩阵', icon: ShieldCheck, desc: '55 API × 4 身份' },
  { key: 'project', name: '项目链', icon: FolderKanban, desc: '建项→成员→任务→归档' },
  { key: 'file', name: '交付催办链', icon: FileCheck2, desc: '文件→审批→催办' },
  { key: 'im', name: 'IM 链', icon: MessageSquare, desc: '会话→消息→@通知' },
  { key: 'purchase', name: '采购链', icon: ShoppingCart, desc: '清单→订单→筛选' },
] as const
type DimKey = (typeof DIMS)[number]['key']

const LEVEL_TONE: Record<QaIssue['level'], string> = {
  P0: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  P1: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  P2: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  P3: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}
const STATUS_TONE: Record<QaIssue['status'], 'secondary' | 'destructive' | 'outline'> = {
  登记: 'secondary',
  修复中: 'destructive',
  已验证: 'outline',
}

function fmtMs(ms: number) {
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

// ── 维度卡片：状态灯 = 最近一次运行里该维 exitCode ──
function DimCard({
  dim, result, running, onRerun, canRerun,
}: {
  dim: (typeof DIMS)[number]
  result?: DimResult
  running: boolean
  onRerun: () => void
  canRerun: boolean
}) {
  const Icon = dim.icon
  const tone = running ? 'text-blue-500' : result == null ? 'text-muted-foreground' : result.exitCode === 0 ? 'text-emerald-500' : 'text-red-500'
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${tone}`} />
            {dim.name}
          </span>
          <span className="text-xs text-muted-foreground" aria-label="状态灯">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : result == null ? '— 未跑' : result.exitCode === 0 ? '✓ 健康' : '✗ 异常'}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">{dim.desc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {result ? (
          <p className="truncate text-xs text-muted-foreground" title={result.tail}>
            {fmtMs(result.durationMs)} · {result.tail || '（无输出）'}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">尚无运行记录</p>
        )}
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!canRerun} onClick={onRerun}>
          <RefreshCw className={`mr-1 h-3 w-3 ${running ? 'animate-spin' : ''}`} />
          重跑此维度
        </Button>
      </CardContent>
    </Card>
  )
}

function CockpitInner() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('overview')
  const [runningDim, setRunningDim] = useState<DimKey | null>(null) // 当前正在跑的维度（loading 动画）
  const [levelFilter, setLevelFilter] = useState<'ALL' | QaIssue['level']>('ALL')

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['qa-cockpit'],
    queryFn: async (): Promise<CockpitData> => {
      const r = await ApiService.get<CockpitData>('/admin/qa-cockpit')
      if (!r.data) throw new Error('响应缺少 data')
      return r.data
    },
  })

  // 单维度运行（一键体检 = 前端循环调用，逐维刷新）
  // timeout 放宽到 300s：axios 实例默认 15s，perm 矩阵等长维度会被前端提前掐断
  // （ApiService.post 的 opts.timeout 即为 AI 等长耗时接口预留的口子）
  const runMutation = useMutation({
    mutationFn: async (dims: DimKey[]) => {
      const r = await ApiService.post<{ okDims: number; totalDims: number }>('/admin/qa-cockpit', {
        action: 'run',
        dims,
      }, { timeout: 300_000 })
      return r.data
    },
  })

  const issues = data?.issues ?? []
  const runs = data?.runs ?? []
  const latest = runs[0]
  const summary = data?.summary

  /** 逐维度串行跑（失败中断并提示），完成统一 invalidate + toast */
  const runDims = async (keys: readonly DimKey[]) => {
    for (const k of keys) {
      setRunningDim(k)
      try {
        await runMutation.mutateAsync([k])
        await qc.invalidateQueries({ queryKey: ['qa-cockpit'] })
      } catch {
        toast({ title: '体检中断', description: `维度「${DIMS.find((d) => d.key === k)?.name}」执行失败（可能已有体检在跑或超时）`, variant: 'destructive' })
        break
      }
    }
    setRunningDim(null)
    await qc.invalidateQueries({ queryKey: ['qa-cockpit'] })
    const fresh = qc.getQueryData<CockpitData>(['qa-cockpit'])
    if (fresh) {
      const run = fresh.runs[0]
      toast({
        description: `体检完成：${run?.okDims ?? 0}/${run?.totalDims ?? keys.length} 维度健康 · 未决问题 ${fresh.summary.openCount} 个（P0 ${fresh.summary.p0} / P1 ${fresh.summary.p1}）`,
      })
    }
  }

  const busy = runningDim != null || runMutation.isPending
  const filtered = levelFilter === 'ALL' ? issues : issues.filter((i) => i.level === levelFilter)

  return (
    <div className="space-y-4">
      {/* ── 顶部：标题 + 一键体检 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">质检驾驶舱</h1>
          <p className="text-sm text-muted-foreground">
            六维健康检查 · 问题台账 · 历史体检
            {latest && <span className="ml-2">上次体检：{fmtTime(latest.startedAt)}（{latest.triggeredBy}）</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={busy}>
            <History className="mr-1 h-4 w-4" /> 刷新
          </Button>
          <Button onClick={() => runDims(DIMS.map((d) => d.key))} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-1 h-4 w-4" />}
            {busy ? `体检中：${DIMS.find((d) => d.key === runningDim)?.name ?? ''}` : '一键体检'}
          </Button>
        </div>
      </div>

      {isPending ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          加载失败，请稍后重试
          <Button size="sm" variant="outline" className="ml-3" onClick={() => refetch()}>重试</Button>
        </CardContent></Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">健康总览</TabsTrigger>
            <TabsTrigger value="issues">问题台账{summary ? `（${summary.openCount}）` : ''}</TabsTrigger>
            <TabsTrigger value="runs">运行日志</TabsTrigger>
          </TabsList>

          {/* ── Tab1 健康总览 ── */}
          <TabsContent value="overview" className="mt-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {DIMS.map((d) => (
                <DimCard
                  key={d.key}
                  dim={d}
                  result={latest?.dims?.[d.key]}
                  running={runningDim === d.key}
                  canRerun={!busy}
                  onRerun={() => runDims([d.key])}
                />
              ))}
            </div>
          </TabsContent>

          {/* ── Tab2 问题台账 ── */}
          <TabsContent value="issues" className="mt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {(['ALL', 'P0', 'P1', 'P2', 'P3'] as const).map((lv) => (
                <Button key={lv} size="sm" variant={levelFilter === lv ? 'default' : 'outline'} className="h-7 px-2.5 text-xs"
                  onClick={() => setLevelFilter(lv)}>
                  {lv === 'ALL' ? `全部 ${issues.length}` : lv}
                </Button>
              ))}
              <span className="ml-auto text-xs text-muted-foreground">
                未决 {summary?.openCount ?? 0} · 已验证 {summary?.verifiedCount ?? 0}
              </span>
            </div>
            {filtered.length === 0 ? (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">该级别暂无登记问题</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2">编号</th><th className="px-3 py-2">级别</th>
                      <th className="px-3 py-2">问题</th><th className="px-3 py-2">位置</th>
                      <th className="px-3 py-2">状态</th><th className="px-3 py-2">来源批次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((it) => (
                      <tr key={it.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono text-xs">{it.id}</td>
                        <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${LEVEL_TONE[it.level]}`}>{it.level}</span></td>
                        <td className="px-3 py-2">{it.title}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{it.location}</td>
                        <td className="px-3 py-2"><Badge variant={STATUS_TONE[it.status]}>{it.status}</Badge></td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{it.batch}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* ── Tab3 运行日志 ── */}
          <TabsContent value="runs" className="mt-3">
            {runs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                <ClipboardList className="h-6 w-6" />
                暂无体检记录，点击「一键体检」生成首份报告
              </div>
            ) : (
              <div className="space-y-2">
                {runs.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="font-medium">{fmtTime(r.startedAt)}</span>
                        <span className="text-xs text-muted-foreground">触发：{r.triggeredBy}</span>
                        <span className="text-xs text-muted-foreground">总耗时 {fmtMs(r.durationMs)}</span>
                        <span className="text-xs text-muted-foreground font-mono">{r.base}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {Object.entries(r.dims).map(([k, v]) => (
                          <span key={k} title={`${k}: ${v.tail}`} className={v.exitCode === 0 ? 'text-emerald-600' : 'text-red-600 font-semibold'}>
                            {k}{v.exitCode === 0 ? '✓' : '✗'}
                          </span>
                        ))}
                        <Badge variant={r.okDims === r.totalDims ? 'outline' : 'destructive'}>{r.okDims}/{r.totalDims} 健康</Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

/** 页面入口：ADMIN 守卫（同 settings 页策略：zustand store 取 user，判 role） */
export default function QaCockpitPage() {
  const user = useAuthStore((s) => s.user)
  if (user?.role !== 'ADMIN') {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-sm text-muted-foreground">
        <ShieldCheck className="h-8 w-8" />
        仅管理员可见
      </div>
    )
  }
  return <CockpitInner />
}
