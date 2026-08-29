'use client'

/**
 * /views/flow —— FlowView（流程图）全面优化版，依据《开发文档-项目管理系统重构》§8.2⑤
 *
 *   - 数据源：GET /api/projects/:id/tree → data.phases[]（§7.4 契约，20 阶段）
 *   - 布局：蛇形（boustrophedon）5 列 × N 行 Z 字排列 —— 相邻阶段永远水平相邻或垂直相邻，
 *     彻底消除「5 个/行换行」导致的长回扫连线；连线为平滑贝塞尔曲线 + 箭头，无交叉
 *   - 节点：PhaseNode（SVG 环形进度 = progress + 状态色渐变背景 + 负责人头像/姓名 + 任务数徽章 + 名称/编号）
 *   - 当前阶段：柔和呼吸光晕（box-shadow 脉冲，非闪烁）
 *   - 背景：网格点（dots）+ 淡渐变底；Controls 缩放平移 + fitView；点击节点下钻阶段页
 *   - 顶部图例（圆点 + 文字）+ 顶部 <ProjectViewPicker />（读 ?projectId=）
 *
 * ⚠️ ProjectViewPicker 内部用 useSearchParams，须用 <Suspense> 包裹（Next.js 预渲染约束）。
 */

import { Suspense, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type NodeProps,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ProjectViewPicker } from '@/components/views/project-view-picker'
import { ProjectDetailService } from '@/services/project-detail'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { PhaseTreeNode, PhaseStatus } from '@/types/project-tree'
import { cn } from '@/lib/utils'
import { GitBranch, ClipboardList, Loader2 } from 'lucide-react'

// ───────────────────────────── 状态配置 ─────────────────────────────
// 阶段状态（§7.4 契约）→ 主色；SKIPPED 图例用灰条纹
const STATUS_CONFIG: Record<PhaseStatus, { color: string; label: string; stripe?: boolean }> = {
  NOT_STARTED: { color: '#94a3b8', label: '未开始' },
  IN_PROGRESS: { color: '#3b82f6', label: '进行中' },
  DONE: { color: '#10b981', label: '已完成' },
  PAUSED: { color: '#f59e0b', label: '已暂停' },
  SKIPPED: { color: '#94a3b8', label: '已跳过', stripe: true },
}

/** SKIPPED 图例圆点的灰条纹背景 */
const STRIPE_STYLE: React.CSSProperties = {
  background: 'repeating-linear-gradient(45deg, #cbd5e1 0 3px, #94a3b8 3px 6px)',
}

// ───────────────────────────── 蛇形布局常量 ─────────────────────────────
const COLS = 5 // 每行 5 个节点；20 阶段 = 5 列 × 4 行 Z 字排列
const NODE_WIDTH = 236
const NODE_HEIGHT = 128
const X_GAP = 60
const Y_GAP = 88

/** 节点 i 的蛇形坐标（偶数行左→右，奇数行右→左） */
function snakePosition(i: number) {
  const row = Math.floor(i / COLS)
  const colInRow = i % COLS
  const col = row % 2 === 0 ? colInRow : COLS - 1 - colInRow
  return { x: col * (NODE_WIDTH + X_GAP), y: row * (NODE_HEIGHT + Y_GAP) }
}

// ───────────────────────────── 自定义节点 ─────────────────────────────

type PhaseNodeData = { phase: PhaseTreeNode; isCurrent: boolean }
type PhaseNodeType = Node<PhaseNodeData, 'phase'>

/** SVG 环形进度（进度 = phase.progress） */
function ProgressRing({ progress, color }: { progress: number; color: string }) {
  const R = 17
  const C = 2 * Math.PI * R
  const pct = Math.max(0, Math.min(100, progress))
  return (
    <svg width={46} height={46} viewBox="0 0 46 46" className="shrink-0" aria-hidden>
      <circle cx={23} cy={23} r={R} fill="none" stroke="rgba(148,163,184,0.25)" strokeWidth={4} />
      <circle
        cx={23}
        cy={23}
        r={R}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${(C * pct) / 100} ${C}`}
        transform="rotate(-90 23 23)"
      />
      <text x={23} y={26.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={color}>
        {pct}%
      </text>
    </svg>
  )
}

/** 不可见连接把手（四向，按 id 指定进出方向，服务蛇形布局） */
function SnakeHandles() {
  const cls = '!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0'
  return (
    <>
      <Handle id="l" type="target" position={Position.Left} className={cls} />
      <Handle id="l" type="source" position={Position.Left} className={cls} />
      <Handle id="r" type="target" position={Position.Right} className={cls} />
      <Handle id="r" type="source" position={Position.Right} className={cls} />
      <Handle id="t" type="target" position={Position.Top} className={cls} />
      <Handle id="t" type="source" position={Position.Top} className={cls} />
      <Handle id="b" type="target" position={Position.Bottom} className={cls} />
      <Handle id="b" type="source" position={Position.Bottom} className={cls} />
    </>
  )
}

function PhaseNodeView({ data }: NodeProps<PhaseNodeType>) {
  const { phase, isCurrent } = data
  const cfg = STATUS_CONFIG[phase.status]
  const ownerName = phase.owner?.name ?? '待分配'
  const initial = ownerName.charAt(0)

  return (
    <div
      className={cn(
        'phase-node relative w-[236px] cursor-pointer rounded-2xl border bg-card p-3.5 transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg',
        isCurrent ? 'phase-node-current border-blue-400/70' : 'border-border/80 shadow-sm'
      )}
      style={{
        // 状态色渐变背景（浅色 tint，不抢内容可读性）
        background: `linear-gradient(135deg, ${cfg.color}1f 0%, ${cfg.color}0a 45%, var(--card) 100%)`,
      }}
    >
      {/* 顶部：环形进度 + 名称/编号/状态 */}
      <div className="flex items-center gap-2.5">
        <ProgressRing progress={phase.progress} color={cfg.color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] font-medium text-muted-foreground">{phase.code}</span>
            <span
              className="ml-auto rounded-full px-1.5 py-px text-[10px] font-semibold leading-4"
              style={{ color: cfg.color, backgroundColor: `${cfg.color}1a` }}
            >
              {cfg.label}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[13px] font-semibold leading-5" title={phase.name}>
            {phase.name}
          </div>
        </div>
      </div>

      {/* 底部：负责人头像/姓名 + 任务数徽章 */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {phase.owner?.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={phase.owner.avatar}
              alt={ownerName}
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ backgroundColor: cfg.color }}
            >
              {initial}
            </span>
          )}
          <span className="truncate">{ownerName}</span>
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title="任务完成数 / 总数"
        >
          <ClipboardList className="h-3 w-3" />
          {phase.taskDone}/{phase.taskCount}
        </span>
      </div>

      <SnakeHandles />
    </div>
  )
}

// nodeTypes 保持模块级稳定引用（ReactFlow 警告：避免每次渲染重建）
const nodeTypes = { phase: PhaseNodeView }

// ───────────────────────────── 页面 ─────────────────────────────

export default function FlowPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-10 animate-pulse rounded bg-muted" />}>
        <FlowViewContent />
      </Suspense>
    </div>
  )
}

function FlowViewContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  return (
    <>
      <ProjectViewPicker />
      {projectId ? <FlowCanvas projectId={projectId} /> : <EmptyGuide />}
    </>
  )
}

function EmptyGuide() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <GitBranch className="mb-3 h-10 w-10 opacity-40" />
        <p className="text-sm">请先在上方选择一个项目，查看 20 阶段流程图</p>
      </CardContent>
    </Card>
  )
}

function FlowCanvas({ projectId }: { projectId: string }) {
  const router = useRouter()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['project', projectId, 'tree'],
    queryFn: () => ProjectDetailService.getTree(projectId),
  })

  const phases = useMemo(() => {
    const list = data?.data?.phases ?? []
    return [...list].sort((a, b) => a.order - b.order)
  }, [data])

  // 当前阶段判定（§8.2⑤）：order 最小且非 DONE 非 SKIPPED；若无则最后一个 DONE
  const currentPhaseId = useMemo(() => {
    const current = phases.find((p) => p.status !== 'DONE' && p.status !== 'SKIPPED')
    if (current) return current.id
    const lastDone = [...phases].reverse().find((p) => p.status === 'DONE')
    return lastDone?.id ?? null
  }, [phases])

  // 蛇形布局节点
  const nodes = useMemo<Node<PhaseNodeData>[]>(
    () =>
      phases.map((p, i) => ({
        id: p.id,
        type: 'phase',
        position: snakePosition(i),
        data: { phase: p, isCurrent: p.id === currentPhaseId },
      })),
    [phases, currentPhaseId]
  )

  // 顺序连线 PH01→PH02→…：蛇形下相邻节点要么水平相邻、要么为行末→下一行行首（垂直相邻），
  // 按几何关系选择进出把手，保证曲线平滑、无交叉、无长回扫线
  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = []
    for (let i = 0; i < phases.length - 1; i++) {
      const a = snakePosition(i)
      const b = snakePosition(i + 1)
      let sourceHandle: string
      let targetHandle: string
      if (a.y === b.y) {
        // 同一行水平连接
        sourceHandle = b.x > a.x ? 'r' : 'l'
        targetHandle = b.x > a.x ? 'l' : 'r'
      } else {
        // 行末折返：下行垂直连接
        sourceHandle = 'b'
        targetHandle = 't'
      }
      list.push({
        id: `e-${phases[i].id}-${phases[i + 1].id}`,
        source: phases[i].id,
        target: phases[i + 1].id,
        sourceHandle,
        targetHandle,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#94a3b8' },
        style: { stroke: '#94a3b8', strokeWidth: 1.6 },
      })
    }
    return list
  }, [phases])

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            阶段流程
            <Badge variant="secondary">{phases.length} 个阶段</Badge>
          </CardTitle>

          {/* 图例（圆点 + 文字） */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5">
            {(Object.keys(STATUS_CONFIG) as PhaseStatus[]).map((key) => {
              const cfg = STATUS_CONFIG[key]
              return (
                <span key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white/60"
                    style={cfg.stripe ? STRIPE_STYLE : { backgroundColor: cfg.color }}
                  />
                  {cfg.label}
                </span>
              )
            })}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex h-[520px] items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载阶段流程…
          </div>
        ) : isError ? (
          <div className="flex h-[520px] items-center justify-center text-muted-foreground">
            阶段流程加载失败，请稍后重试
          </div>
        ) : phases.length === 0 ? (
          <div className="flex h-[520px] items-center justify-center text-muted-foreground">
            该项目暂无阶段数据
          </div>
        ) : (
          <div
            className="relative w-full overflow-hidden"
            style={{ height: 'clamp(480px, calc(100vh - 300px), 860px)' }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => {
                router.push(`/projects/${projectId}/phases/${node.id}`)
              }}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              minZoom={0.15}
              maxZoom={1.6}
              nodesConnectable={false}
              nodesDraggable
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1.2}
                color="rgba(148,163,184,0.35)"
                style={{
                  background:
                    'radial-gradient(ellipse at top left, rgba(59,130,246,0.05), transparent 55%), radial-gradient(ellipse at bottom right, rgba(16,185,129,0.05), transparent 55%)',
                }}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )}

        {/* 当前阶段呼吸光晕：柔和 box-shadow 脉冲（非闪烁） */}
        <style>{`
          @keyframes phase-glow {
            0%, 100% { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22), 0 8px 24px -8px rgba(59, 130, 246, 0.35); }
            50% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0.05), 0 8px 32px -6px rgba(59, 130, 246, 0.22); }
          }
          .phase-node-current { animation: phase-glow 2.6s ease-in-out infinite; }
          @media (prefers-reduced-motion: reduce) {
            .phase-node-current { animation: none; box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18); }
          }
        `}</style>
      </CardContent>
    </Card>
  )
}
