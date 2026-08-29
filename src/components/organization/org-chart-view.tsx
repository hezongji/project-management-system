'use client'

/**
 * OrgChartView —— 组织架构图（P2 增强版）
 *
 * 数据源：GET /api/org-chart（loadDeptTree：部门树含负责人/成员数/直属在职成员）
 *
 * 1. 自上而下树形布局：根部门 → 子部门 → 成员，连线表示隶属关系；
 *    父节点水平居中于其子节点区间，手写递归布局（子树宽度累加）。
 * 2. 部门节点：名称 + 负责人 + 成员数 + 层级缩进感（按深度渐变配色）；
 *    成员节点：头像首字 + 姓名 + 岗位，连到所属部门。
 * 3. 部门可折叠：点击节点下方徽章收起/展开其子部门与成员，
 *    折叠时显示「N 部门 · M 人」汇总；工具栏提供全部展开/全部折叠。
 * 4. 点击部门节点 → 右侧详情面板（负责人 / 直属成员）；缩放平移自由。
 */

import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { OrgService, type OrgChart } from '@/services/org'
import type { DeptNode } from '@/lib/org-tree'
import { cn } from '@/lib/utils'
import {
  Loader2,
  Network,
  Building2,
  Users,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Pencil,
} from 'lucide-react'

// ───────────────────────────── 布局常量 ─────────────────────────────

const DEPT_W = 186
const DEPT_H = 88
const MEMBER_W = 132
const MEMBER_H = 54
const H_GAP = 18 // 同层相邻节点水平间距
const V_GAP = 96 // 层间垂直间距

/** 部门节点按深度的顶部色条/边框配色（层级感，适配深浅色） */
const DEPTH_STYLE = [
  {
    bar: 'bg-indigo-600 dark:bg-indigo-500',
    border: 'border-indigo-300 dark:border-indigo-500/40',
    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
  },
  {
    bar: 'bg-blue-500',
    border: 'border-blue-300 dark:border-blue-500/40',
    badge: 'bg-blue-50 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  },
  {
    bar: 'bg-cyan-500',
    border: 'border-cyan-300 dark:border-cyan-500/40',
    badge: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300',
  },
  {
    bar: 'bg-slate-400 dark:bg-slate-500',
    border: 'border-slate-300 dark:border-slate-600',
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300',
  },
]
/** 层级名称（展示「一级部门/二级部门/…」） */
const DEPTH_TEXT = ['一级部门', '二级部门', '三级部门', '四级部门']

// ───────────────────────────── 节点 data 契约 ─────────────────────────────

interface DeptNodeData extends Record<string, unknown> {
  label: string
  managerName: string | null
  memberCount: number
  depth: number
  selected: boolean
  collapsed: boolean
  /** 折叠时的汇总：子部门数 / 含子级总人数 */
  hiddenDeptCount: number
  hiddenMemberCount: number
  hasChildren: boolean
  onToggleCollapse: (id: string) => void
  /** 打开部门编辑弹窗 */
  onEdit?: () => void
}

interface MemberNodeData extends Record<string, unknown> {
  name: string
  jobTitle: string | null
  isManager: boolean
}

type ChartNode = Node<DeptNodeData> | Node<MemberNodeData>

// ───────────────────────────── 自定义节点 ─────────────────────────────

function DeptCardNode({ id, data }: NodeProps<Node<DeptNodeData>>) {
  const d = data
  const style = DEPTH_STYLE[Math.min(d.depth, DEPTH_STYLE.length - 1)]
  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md',
        style.border,
        d.selected && 'ring-2 ring-primary/40'
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/30" />
      <div className={cn('h-1 w-full', style.bar)} />
      <div className="flex min-h-0 flex-1 flex-col justify-center px-3 py-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-foreground">{d.label}</span>
          <span className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium', style.badge)}>
            {d.memberCount} 人
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {d.managerName ? `负责人：${d.managerName}` : '未设负责人'}
        </div>
        <div className={cn('mt-0.5 w-fit rounded px-1 text-[8px] font-medium leading-tight', style.badge)}>
          {DEPTH_TEXT[Math.min(d.depth, DEPTH_TEXT.length - 1)]}
        </div>
      </div>
      <button
        className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        title="编辑部门"
        onClick={(e) => {
          e.stopPropagation()
          d.onEdit?.()
        }}
      >
        <Pencil className="h-3 w-3" />
      </button>
      {d.hasChildren && (
        <button
          className="absolute -bottom-0 left-1/2 z-10 flex h-5 w-10 -translate-x-1/2 translate-y-1/2 items-center justify-center gap-0.5 rounded-full border bg-background text-[9px] text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
          title={d.collapsed ? '展开' : '折叠'}
          onClick={(e) => {
            e.stopPropagation()
            d.onToggleCollapse(id)
          }}
        >
          {d.collapsed ? (
            <>
              <ChevronDown className="h-2.5 w-2.5" />
              {d.hiddenDeptCount > 0 && <span>{d.hiddenDeptCount}部</span>}
              {d.hiddenMemberCount > 0 && <span>{d.hiddenMemberCount}人</span>}
            </>
          ) : (
            <ChevronDown className="h-2.5 w-2.5 rotate-180" />
          )}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/30" />
    </div>
  )
}

function MemberCardNode({ data }: NodeProps<Node<MemberNodeData>>) {
  const d = data
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 shadow-sm">
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/30" />
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          d.isManager
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
            : 'bg-primary/10 text-primary'
        )}
      >
        {d.name.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground">
          {d.name}
          {d.isManager && <span className="ml-0.5 text-[9px] text-amber-600">★</span>}
        </div>
        <div className="truncate text-[9px] text-muted-foreground">{d.jobTitle ?? '未设岗位'}</div>
      </div>
    </div>
  )
}

const nodeTypes = {
  dept: DeptCardNode,
  member: MemberCardNode,
} as const

// ───────────────────────────── 布局算法（自上而下） ─────────────────────────────

interface BuiltGraph {
  nodes: ChartNode[]
  edges: Edge[]
}

/** 统计子树（含自身）部门数与总成员数 */
function subtreeStats(n: DeptNode): { depts: number; members: number } {
  let depts = 1
  let members = n.members.length
  for (const c of n.children) {
    const s = subtreeStats(c)
    depts += s.depts
    members += s.members
  }
  return { depts, members }
}

/**
 * 递归布局：叶子按游标顺序排布，父节点水平居中于首尾子节点。
 * 子部门在前、直属成员在后（同层从左到右）。
 */
function buildGraph(
  roots: DeptNode[],
  collapsed: Set<string>,
  selectedDeptId: string | null,
  onToggleCollapse: (id: string) => void,
  onEditDept: (dept: DeptNode) => void
): BuiltGraph {
  const nodes: ChartNode[] = []
  const edges: Edge[] = []
  let cursor = 0

  /** 返回该部门节点的中心 x */
  function walkDept(n: DeptNode, depth: number): number {
    const isCollapsed = collapsed.has(n.id)
    const visibleChildDepts = isCollapsed ? [] : n.children
    const visibleMembers = isCollapsed ? [] : n.members
    const hasChildren = visibleChildDepts.length + visibleMembers.length > 0

    let cx: number
    if (!hasChildren) {
      cx = cursor + DEPT_W / 2
      cursor += DEPT_W + H_GAP
    } else {
      const centers: number[] = []
      for (const c of visibleChildDepts) centers.push(walkDept(c, depth + 1))
      for (const m of visibleMembers) {
        const mx = cursor + MEMBER_W / 2
        cursor += MEMBER_W + H_GAP
        nodes.push({
          id: `member:${m.id}`,
          type: 'member',
          position: { x: mx - MEMBER_W / 2, y: (depth + 1) * (DEPT_H + V_GAP) },
          style: { width: MEMBER_W, height: MEMBER_H },
          data: {
            name: m.name,
            jobTitle: m.jobTitle,
            isManager: n.managerId === m.id,
          } satisfies MemberNodeData,
        })
        edges.push({
          id: `e-${n.id}-m-${m.id}`,
          source: n.id,
          target: `member:${m.id}`,
          type: 'smoothstep',
          style: { stroke: 'hsl(var(--border))', strokeWidth: 1 },
        })
        centers.push(mx)
      }
      cx = (centers[0] + centers[centers.length - 1]) / 2
    }

    const stats = subtreeStats(n)
    nodes.push({
      id: n.id,
      type: 'dept',
      position: { x: cx - DEPT_W / 2, y: depth * (DEPT_H + V_GAP) },
      style: { width: DEPT_W, height: DEPT_H },
      data: {
        label: n.name,
        managerName: n.manager?.name ?? null,
        memberCount: n.memberCount,
        depth,
        selected: n.id === selectedDeptId,
        collapsed: isCollapsed,
        hiddenDeptCount: stats.depts - 1,
        hiddenMemberCount: stats.members,
        hasChildren: n.children.length + n.members.length > 0,
        onToggleCollapse,
        onEdit: () => onEditDept(n),
      } satisfies DeptNodeData,
    })

    for (const c of visibleChildDepts) {
      edges.push({
        id: `e-${n.id}-${c.id}`,
        source: n.id,
        target: c.id,
        type: 'smoothstep',
        style: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1.5 },
      })
    }

    return cx
  }

  roots.forEach((r) => walkDept(r, 0))
  return { nodes, edges }
}

/** 收集所有「有子级」的部门 id（全部展开/折叠用） */
function collectExpandable(nodes: DeptNode[]): Set<string> {
  const out = new Set<string>()
  function walk(n: DeptNode) {
    if (n.children.length + n.members.length > 0) out.add(n.id)
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

// ───────────────────────────── 主组件 ─────────────────────────────

export function OrgChartView() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editDept, setEditDept] = useState<DeptNode | null>(null)
  const [editName, setEditName] = useState('')
  const [editParentId, setEditParentId] = useState('')
  const [editManagerId, setEditManagerId] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  const { data, isLoading, error } = useQuery<OrgChart>({
    queryKey: ['org-chart'],
    queryFn: OrgService.getOrgChart,
  })

  /** 拍平部门树：供上级下拉 */
  const flatDepts = useMemo<DeptNode[]>(() => {
    const out: DeptNode[] = []
    const walk = (ns: DeptNode[]) => {
      ns.forEach((n) => {
        out.push(n)
        walk(n.children)
      })
    }
    if (data) walk(data.departments)
    return out
  }, [data])

  /** 拍平全部成员：供负责人下拉 */
  const allMembers = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    flatDepts.forEach((d) => d.members.forEach((m) => map.set(m.id, { id: m.id, name: m.name })))
    return Array.from(map.values())
  }, [flatDepts])

  const openEditDept = useCallback((dept: DeptNode) => {
    setEditDept(dept)
    setEditName(dept.name)
    setEditParentId(dept.parentId ?? '')
    setEditManagerId(dept.managerId ?? '')
  }, [])

  const saveEditDept = useCallback(async () => {
    if (!editDept) return
    if (!editName.trim()) {
      toast({ title: '请填写部门名称', variant: 'destructive' })
      return
    }
    setEditSaving(true)
    try {
      await OrgService.updateDepartment(editDept.id, {
        name: editName.trim(),
        parentId: editParentId || null,
        managerId: editManagerId || null,
      })
      toast({ title: '部门已更新' })
      setEditDept(null)
      queryClient.invalidateQueries({ queryKey: ['org-chart'] })
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (err as Error).message
      toast({ title: '更新失败', description: msg, variant: 'destructive' })
    } finally {
      setEditSaving(false)
    }
  }, [editDept, editName, editParentId, editManagerId, toast, queryClient])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedDept = useMemo<DeptNode | null>(() => {
    if (!data || !selectedDeptId) return null
    const found: DeptNode[] = []
    function walk(n: DeptNode) {
      if (n.id === selectedDeptId) found.push(n)
      n.children.forEach(walk)
    }
    data.departments.forEach(walk)
    return found[0] ?? null
  }, [data, selectedDeptId])

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as ChartNode[], edges: [] as Edge[] }
    return buildGraph(data.departments, collapsed, selectedDeptId, toggleCollapse, openEditDept)
  }, [data, collapsed, selectedDeptId, toggleCollapse])

  const handleNodeClick = useCallback((_: React.MouseEvent, node: ChartNode) => {
    if (node.type === 'dept') setSelectedDeptId(node.id)
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载组织架构图…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <span className="text-destructive">加载失败，请稍后重试</span>
      </div>
    )
  }

  const expandable = collectExpandable(data.departments)

  return (
    <div className="space-y-3">
      {/* 统计条 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Building2 className="h-4 w-4" /> {data.stats.deptTotal} 个部门
        </span>
        <span className="flex items-center gap-1.5">
          <Users className="h-4 w-4" /> 在职 {data.stats.userTotal} 人
        </span>
        <span>外部主体 {data.stats.externalTotal} 家</span>
      </div>

      <div>
        {/* 架构图（占满可视区，节点可拖拽） */}
        <div className="relative h-[calc(100vh-210px)] min-h-[520px] overflow-hidden rounded-xl border border-border bg-muted/30 dark:bg-muted/20">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.05}
            maxZoom={2}
            nodesDraggable
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            colorMode="system"
          >
            <Background gap={24} size={1.5} color="hsl(var(--border))" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden sm:!block" />
            <Panel position="top-left">
              <div className="flex flex-wrap items-center gap-2">
                <div className="rounded-lg border border-border bg-white/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm">
                  自上而下：部门 → 子部门 → 成员；点击部门看详情，点底部按钮折叠
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 bg-white/95 text-[11px]"
                  onClick={() => setCollapsed(new Set())}
                >
                  <ChevronsUpDown className="mr-1 h-3.5 w-3.5" /> 全部展开
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 bg-white/95 text-[11px]"
                  onClick={() => setCollapsed(new Set(expandable))}
                >
                  <ChevronsDownUp className="mr-1 h-3.5 w-3.5" /> 全部折叠
                </Button>
              </div>
            </Panel>
          </ReactFlow>
        </div>
      </div>

      {/* 部门编辑弹窗 */}
      <Dialog open={editDept !== null} onOpenChange={(o) => !o && setEditDept(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑部门</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>部门名称 *</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="部门名称" />
            </div>
            <div className="space-y-1">
              <Label>上级部门</Label>
              <select
                value={editParentId}
                onChange={(e) => setEditParentId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">无（顶级部门）</option>
                {flatDepts
                  .filter((d) => d.id !== editDept?.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>部门负责人</Label>
              <select
                value={editManagerId}
                onChange={(e) => setEditManagerId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">未设置</option>
                {allMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDept(null)}>
              取消
            </Button>
            <Button onClick={saveEditDept} disabled={editSaving}>
              {editSaving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
