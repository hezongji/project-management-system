'use client'

/**
 * PhaseTree（项目根树）—— §8.2① 组件契约
 *   props: { projectId }；数据: GET /projects/:id/tree（React Query，与页面同 key 共享缓存）
 *   交互: 阶段卡（状态色条/进度环/负责人头像/日期/延误红标/文件徽章）→ 点击下钻
 *         行内: [完成勾(权限)] [跳过(权限+备注弹窗)] [改派负责人] [删除(权限+二次确认)]
 *   拖拽: 同级排序 → PATCH 批量 order（仅项目 OWNER/ADMIN，乐观更新失败回滚）
 *
 * 权限口径（与 §6.1 权限引擎基线一致，服务端 requireCan 为最终裁决）：
 *   canEdit    = myRole ∈ {OWNER, MANAGER, ADMIN}（项目级 edit）
 *   canReorder = myRole ∈ {OWNER, ADMIN}（§8.2① 字面）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, ListTree } from 'lucide-react'

import { useToast } from '@/components/ui/use-toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PhaseCard } from '@/components/projects/phase-card'
import { SkipPhaseDialog } from '@/components/projects/skip-phase-dialog'
import { AssignOwnerDialog } from '@/components/projects/assign-owner-dialog'
import { ProjectDetailService } from '@/services/project-detail'
import { ApiService } from '@/services/api'
import type { PhaseTreeNode } from '@/types/project-tree'
import { cn } from '@/lib/utils'

interface PhaseTreeProps {
  projectId: string
}

export function PhaseTree({ projectId }: PhaseTreeProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', projectId, 'tree'],
    queryFn: () => ProjectDetailService.getTree(projectId),
  })

  // ── 拖拽排序状态 ──
  const [localOrder, setLocalOrder] = React.useState<PhaseTreeNode[] | null>(null)
  const [draggingIndex, setDraggingIndex] = React.useState<number | null>(null)
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)

  // ── 弹窗状态 ──
  const [skipTarget, setSkipTarget] = React.useState<PhaseTreeNode | null>(null)
  const [assignTarget, setAssignTarget] = React.useState<PhaseTreeNode | null>(null)
  const [completingId, setCompletingId] = React.useState<string | null>(null)

  // ── 删除阶段（删除工程第 2 棒：二次确认 → DELETE /api/phases/:id）──
  const [deleteTarget, setDeleteTarget] = React.useState<PhaseTreeNode | null>(null)
  const [deletingPhaseId, setDeletingPhaseId] = React.useState<string | null>(null)
  const handleDeletePhase = async (phase: PhaseTreeNode) => {
    setDeletingPhaseId(phase.id)
    try {
      await ApiService.delete(`/phases/${phase.id}`)
      toast({ description: `阶段 ${phase.code} 已删除` })
      setDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
    } catch (e) {
      toast({
        title: '删除失败',
        description: e instanceof Error ? e.message : '操作失败',
        variant: 'destructive',
      })
    } finally {
      setDeletingPhaseId(null)
    }
  }

  const tree = data?.data
  const myRole = tree?.project.myRole ?? null
  const canEdit = myRole === 'OWNER' || myRole === 'MANAGER' || myRole === 'ADMIN'
  const canReorder = myRole === 'OWNER' || myRole === 'ADMIN'

  // 乐观顺序：拖拽后本地先渲染，落库失败回滚（直接弃用本地态回服务端缓存）
  const phases = localOrder ?? tree?.phases ?? []

  React.useEffect(() => {
    // 服务端数据刷新时弃用本地乐观顺序
    setLocalOrder(null)
  }, [tree])

  // ── 完成勾：PATCH /phases/:id { status: 'DONE' } ──
  const handleComplete = async (phase: PhaseTreeNode) => {
    setCompletingId(phase.id)
    try {
      const res = await ProjectDetailService.patchPhase(phase.id, { status: 'DONE' })
      toast({ description: res.data?.message ?? '阶段已完成' })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
    } catch (e) {
      toast({
        title: '无法标记完成',
        description: e instanceof Error ? e.message : '操作失败',
        variant: 'destructive',
      })
    } finally {
      setCompletingId(null)
    }
  }

  // ── 拖拽：同级排序 → PATCH /projects/:id/phases/order ──
  const commitReorder = async (next: PhaseTreeNode[]) => {
    setLocalOrder(next)
    try {
      await ProjectDetailService.reorderPhases(
        projectId,
        next.map((p, i) => ({ id: p.id, order: i + 1 })),
      )
      await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
      toast({ description: '阶段顺序已保存' })
    } catch (e) {
      setLocalOrder(null) // 回滚
      toast({
        title: '排序保存失败',
        description: e instanceof Error ? e.message : '已回滚',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载阶段根树…
      </div>
    )
  }

  if (error || !tree) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        {error instanceof Error ? error.message : '根树数据加载失败'}
      </div>
    )
  }

  if (tree.phases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-muted-foreground">
        <ListTree className="h-8 w-8 opacity-40" />
        该项目还没有阶段（未按流程模板实例化）
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {canReorder && (
        <p className="px-1 text-xs text-muted-foreground">
          可拖拽阶段卡调整同级顺序（仅项目负责人 / 管理员）
        </p>
      )}
      <ul className={cn('space-y-2', canReorder && '[&>li]:touch-none')}>
        {phases.map((p, i) => (
          <PhaseCard
            key={p.id}
            index={i}
            phase={p}
            projectId={projectId}
            canEdit={canEdit}
            canReorder={canReorder}
            completing={completingId === p.id}
            onComplete={handleComplete}
            onSkip={setSkipTarget}
            onAssign={setAssignTarget}
            onDelete={setDeleteTarget}
            dragging={draggingIndex === i}
            dropTarget={dropIndex === i && draggingIndex !== null && draggingIndex !== i}
            onDragStart={(_, idx) => setDraggingIndex(idx)}
            onDragOver={(e, idx) => {
              e.preventDefault()
              setDropIndex(idx)
            }}
            onDrop={(e, idx) => {
              e.preventDefault()
              setDropIndex(null)
              setDraggingIndex(null)
              const from = draggingIndex
              if (from === null || from === idx || !tree) return
              const next = [...phases]
              const [moved] = next.splice(from, 1)
              next.splice(idx, 0, moved)
              void commitReorder(next)
            }}
            onDragEnd={() => {
              setDraggingIndex(null)
              setDropIndex(null)
            }}
          />
        ))}
      </ul>

      <SkipPhaseDialog
        phase={skipTarget}
        projectId={projectId}
        open={skipTarget !== null}
        onOpenChange={(o) => !o && setSkipTarget(null)}
      />
      <AssignOwnerDialog
        phase={assignTarget}
        members={tree.members}
        projectId={projectId}
        open={assignTarget !== null}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />

      {/* 删除阶段二次确认（删除工程第 2 棒；文案列明级联影响） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget
            ? `删除阶段 ${deleteTarget.code}「${deleteTarget.name}」`
            : '删除阶段'
        }
        description="将永久删除该阶段及其绑定的文件目录/文件条目（含已上传文件），并清理相关待办/通知/催办记录。该操作不可恢复。"
        confirmText="永久删除"
        destructive
        loading={deletingPhaseId !== null && deletingPhaseId === deleteTarget?.id}
        onConfirm={() =>
          deleteTarget ? handleDeletePhase(deleteTarget) : Promise.resolve()
        }
      />
    </div>
  )
}
