'use client'

/**
 * /projects/[id] 项目详情（根树页）—— 依据《开发文档-项目管理系统重构》§7.4、§8.2①
 *
 * 页头：项目基本信息卡（编号/状态/金额/合同/地点/日期/进度环大号/myRole）
 *       + [编辑]（can.edit → PATCH 基本信息弹窗）+ [归档]（can.archive → 拦截缺项清单展示）
 * 主体：<PhaseTree projectId>（§8.2① 契约组件，同 queryKey 共享缓存）
 * 文件汇总条：fileSummary（required/approved/waiting/rejected）
 */

import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  FileCheck2,
  Loader2,
  MapPin,
  Pencil,
  Archive,
  Hash,
  CalendarRange,
  Banknote,
  FileWarning,
  FolderArchive,
  Users,
  UserPlus,
  UserMinus,
  ClipboardList,
  ShieldCheck,
  BarChart3,
  ShoppingCart,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PhaseTree } from '@/components/projects/phase-tree'
import { ProgressRing } from '@/components/projects/progress-ring'
import { ImAvatar } from '@/components/im/message-bubble'
import { MemberPicker, type PickerMember } from '@/components/im/member-picker'
import { DeliverableBoard } from '@/components/projects/deliverable-board'
import { PermissionMatrixDialog } from '@/components/projects/permission-matrix'
import { ExpenseClaimCard } from '@/components/expense/expense-claim-card'
import { ApiService } from '@/services/api'
import { ProjectDetailService, ArchiveBlockedError } from '@/services/project-detail'
import { label, FILE_STATUS, TASK_STATUS } from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { ArchiveBlocker, TreeProject } from '@/types/project-tree'
import type { FileRequirementItem } from '@/types/files'

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: '进行中',
  ON_HOLD: '暂停',
  COMPLETED: '已完成',
  CANCELLED: '已作废',
}
const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-blue-100 text-blue-700 hover:bg-blue-100',
  ON_HOLD: 'bg-gray-100 text-gray-600 hover:bg-gray-100',
  COMPLETED: 'bg-green-100 text-green-700 hover:bg-green-100',
  CANCELLED: 'bg-red-100 text-red-700 hover:bg-red-100',
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('zh-CN') : '—'
const fmtAmount = (n: number | null) =>
  n === null ? '—' : `¥${n.toLocaleString('zh-CN')}`

const MEMBER_ROLE_TEXT: Record<string, string> = {
  OWNER: '负责人',
  MANAGER: '经理',
  MEMBER: '成员',
  VIEWER: '访客',
}

/** 历史台账项目档案卡（isLegacy=true 时替代空 PhaseTree，见 audit P0-2） */
function LegacyProjectCard({ project }: { project: TreeProject }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: '项目编号', value: <span className="font-mono">{project.code}</span> },
    { label: '项目名称', value: project.name },
    { label: '合同号', value: project.contractNo || '—' },
    { label: '施工地点', value: project.location || '—' },
    { label: '签约日期', value: fmtDate(project.signedAt) },
    { label: '合同金额', value: fmtAmount(project.amount) },
    { label: '客户', value: project.customer?.name || '—' },
    { label: '状态', value: STATUS_TEXT[project.status] ?? project.status },
    { label: '归档标识', value: project.isArchived ? '已归档' : '未归档' },
  ]

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <FolderArchive className="h-5 w-5 text-muted-foreground" />
          <span className="text-base font-semibold">历史台账项目档案</span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 md:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="space-y-1">
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="text-sm font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          该台账项目未走线上流程，仅存档
        </p>
      </CardContent>
    </Card>
  )
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>()
  const projectId = params.id
  const router = useRouter()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', projectId, 'tree'],
    queryFn: () => ProjectDetailService.getTree(projectId),
  })

  // ── 编辑弹窗 ──
  const [editOpen, setEditOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    name: '',
    description: '',
    location: '',
    amount: '',
  })
  const [saving, setSaving] = React.useState(false)

  // ── 归档 ──
  const [archiving, setArchiving] = React.useState(false)
  const [blockers, setBlockers] = React.useState<ArchiveBlocker[] | null>(null)

  // ── 成员管理（P0-8）──
  const [memberPickerOpen, setMemberPickerOpen] = React.useState(false)
  const [boardOpen, setBoardOpen] = React.useState(false)
  const [addingMember, setAddingMember] = React.useState(false)
  const [removingId, setRemovingId] = React.useState<string | null>(null)

  // ── 权限矩阵（P1-2）──
  const [permOpen, setPermOpen] = React.useState(false)
  const [viewOpen, setViewOpen] = React.useState(false)
  // ── 删除项目（删除工程第 2 棒：仅 ADMIN / OWNER，二次确认 + 级联影响告知）──
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const doDeleteProject = async () => {
    setDeleting(true)
    try {
      await ApiService.delete(`/projects/${projectId}`)
      toast({ description: '项目已删除' })
      setDeleteOpen(false)
      router.push('/projects')
    } catch (e) {
      toast({
        title: '删除失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }
  // ★ AI 汇总（S4）：POST /api/ai/summarize {type:'project'}
  const [aiOpen, setAiOpen] = React.useState(false)
  // ── 删除工程第 4 棒：文件卡片删除入口（仅 WAITING；owner/reviewer/ADMIN；服务端终审）──
  const { data: me } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () =>
      ApiService.get<{ id: string; role: string; department?: { id: string; name: string } | null }>(
        '/auth/me',
      ).then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })
  const [fileReqDeleting, setFileReqDeleting] = React.useState<FileRequirementItem | null>(null)
  const [fileReqDeleteBusy, setFileReqDeleteBusy] = React.useState(false)
  const doDeleteFileReq = async () => {
    if (!fileReqDeleting) return
    setFileReqDeleteBusy(true)
    try {
      await ApiService.delete(`/file-requirements/${fileReqDeleting.id}`)
      toast({ description: `文件条目「${fileReqDeleting.name}」已删除` })
      setFileReqDeleting(null)
      // 条目副芘2（同步修复）：删除后同步失效其他持有文件条目数据的缓存，
      // 避免files 页/工作台仍是已删条目
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project-files', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['file-requirements'] }),
        queryClient.invalidateQueries({ queryKey: ['my-deliverables'] }),
        queryClient.invalidateQueries({ queryKey: ['deliverable-board'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] }),
      ])
    } catch (e) {
      toast({
        title: '删除失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setFileReqDeleteBusy(false)
    }
  }
  const [aiBusy, setAiBusy] = React.useState(false)
  const [aiSummary, setAiSummary] = React.useState<{
    projectLabel?: string
    summary: string
    stats?: { progressPercent?: number; taskStats?: Record<string, number>; fileStats?: Record<string, number>; phaseCount?: number }
  } | null>(null)
  const runAiSummary = async () => {
    if (aiBusy || !projectId) return
    setAiOpen(true)
    setAiBusy(true)
    setAiSummary(null)
    try {
      const res = await ApiService.post<{
        projectLabel?: string
        summary: string
        stats?: { progressPercent?: number; taskStats?: Record<string, number>; fileStats?: Record<string, number>; phaseCount?: number }
      }>('/ai/summarize', { type: 'project', projectId }, { timeout: 120_000 })
      setAiSummary(res.data ?? null)
    } catch (e) {
      setAiSummary({ summary: `AI 汇总失败：${e instanceof Error ? e.message : '请稍后重试'}` })
    } finally {
      setAiBusy(false)
    }
  }

  // ── 项目文件条目（§7.7：项目文件列表 + 状态）──
  const { data: fileReqs } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () =>
      ApiService.get<{ items: FileRequirementItem[] }>(
        `/file-requirements?projectId=${projectId}&limit=50`,
      ),
    enabled: !!projectId,
  })
  const projectFiles = fileReqs?.data?.items ?? []

  const tree = data?.data

  // ── 成员管理：加人 / 移除（P0-8）──
  const handleAddMembers = async (selected: PickerMember[]) => {
    const userIds = selected.map((s) => s.id)
    if (userIds.length === 0) return
    setAddingMember(true)
    try {
      await ApiService.post(`/projects/${projectId}/members`, { userIds })
      toast({ description: `已添加 ${userIds.length} 名成员` })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '添加失败',
      })
    } finally {
      setAddingMember(false)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    setRemovingId(userId)
    try {
      await ApiService.delete(`/projects/${projectId}/members/${userId}`)
      toast({ description: '已移除成员' })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '移除失败',
      })
    } finally {
      setRemovingId(null)
    }
  }

  const openEdit = () => {
    if (!tree) return
    setForm({
      name: tree.project.name,
      description: '',
      location: tree.project.location ?? '',
      amount: tree.project.amount === null ? '' : String(tree.project.amount),
    })
    setEditOpen(true)
  }

  const saveEdit = async () => {
    setSaving(true)
    try {
      await ProjectDetailService.patchProject(projectId, {
        name: form.name.trim(),
        ...(form.location.trim() ? { location: form.location.trim() } : {}),
        ...(form.amount !== ''
          ? { amount: Number(form.amount) }
          : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      })
      toast({ description: '项目信息已更新' })
      setEditOpen(false)
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
    } catch (e) {
      toast({
        title: '保存失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const doArchive = async () => {
    setArchiving(true)
    try {
      await ProjectDetailService.archive(projectId)
      toast({ description: '项目已归档（对非管理员转为只读）' })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
      setBlockers(null)
    } catch (e) {
      if (e instanceof ArchiveBlockedError) {
        setBlockers(e.blockers ?? [])
      } else {
        toast({
          title: '归档失败',
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        })
      }
    } finally {
      setArchiving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        正在加载项目…
      </div>
    )
  }

  if (error || !tree) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="mb-3 text-muted-foreground">
          {error instanceof Error ? error.message : '项目加载失败（可能无权限或不存在）'}
        </p>
        <Button variant="outline" onClick={() => router.push('/projects')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回项目列表
        </Button>
      </div>
    )
  }

  const { project, fileSummary, isLegacy, members } = tree

  // 删除权限：仅系统管理员或项目负责人（与服务端 DELETE 鉴权口径一致）
  const canDeleteProject = project.myRole === 'ADMIN' || project.myRole === 'OWNER'

  return (
    <div className="w-full space-y-6 p-4 md:p-6">
      {/* ── 项目头卡 ── */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => router.push('/projects')}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  项目
                </Button>
                <span className="font-mono">{project.code}</span>
                <Badge
                  variant="secondary"
                  className={STATUS_BADGE[project.status] ?? ''}
                >
                  {STATUS_TEXT[project.status] ?? project.status}
                </Badge>
                {project.myRole && (
                  <Badge variant="outline" className="text-xs">
                    我的角色：{project.myRole === 'ADMIN' ? '系统管理员' : project.myRole}
                  </Badge>
                )}
              </div>
              <h1 className="truncate text-xl font-semibold md:text-2xl">{project.name}</h1>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Banknote className="h-4 w-4" />
                  {fmtAmount(project.amount)}
                </span>
                {project.contractNo && (
                  <span className="inline-flex items-center gap-1.5">
                    <Hash className="h-4 w-4" />
                    合同 {project.contractNo}
                  </span>
                )}
                {project.location && (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-4 w-4" />
                    {project.location}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <CalendarRange className="h-4 w-4" />
                  {fmtDate(project.plannedStart)} ~ {fmtDate(project.plannedEnd)}
                </span>
                {isLegacy ? (
                  <span className="inline-flex items-center gap-1.5">
                    <FileCheck2 className="h-4 w-4" />
                    无文件记录
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <FileCheck2 className="h-4 w-4" />
                    必需文件 {fileSummary.approved}/{fileSummary.required} 通过
                    {fileSummary.rejected > 0 && (
                      <span className="text-red-600">（{fileSummary.rejected} 驳回）</span>
                    )}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {isLegacy ? (
                <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-2 text-muted-foreground">
                  <FolderArchive className="h-8 w-8" />
                  <p className="text-xs">历史台账</p>
                </div>
              ) : (
                <div className="text-center">
                  <ProgressRing value={project.progress} size={64} stroke={6} />
                  <p className="mt-1 text-xs text-muted-foreground">总进度</p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                {project.can.edit && (
                  <Button variant="outline" size="sm" onClick={openEdit}>
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    编辑
                  </Button>
                )}
                {project.can.edit && (
                  <Button variant="outline" size="sm" onClick={() => setPermOpen(true)}>
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                    权限
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setViewOpen(true)}>
                  <BarChart3 className="mr-1 h-3.5 w-3.5" />
                  视图
                </Button>
                <Button variant="outline" size="sm" onClick={runAiSummary} disabled={aiBusy}>
                  <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />
                  {aiBusy ? 'AI 汇总中…' : 'AI 汇总'}
                </Button>
                {project.can.archive && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-amber-700 hover:text-amber-800"
                    disabled={archiving}
                    onClick={doArchive}
                  >
                    {archiving ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Archive className="mr-1 h-3.5 w-3.5" />
                    )}
                    归档
                  </Button>
                )}
                {canDeleteProject && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={deleting || project.isArchived}
                    title={
                      project.isArchived
                        ? '已归档项目不可删除，请先解除归档'
                        : '删除项目（不可恢复，需二次确认）'
                    }
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    删除
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* 归档拦截缺项清单（§7.7 errors[] 格式渲染） */}
          {blockers && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
                <FileWarning className="h-4 w-4" />
                存在未通过的必需文件，无法归档（{blockers.length} 项）
              </p>
              <ul className="space-y-1 text-sm">
                {blockers.map((b, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {label(FILE_STATUS, b.status)}
                    </Badge>
                    <span>{b.name}</span>
                    <span className="text-xs text-muted-foreground">
                      责任人：{b.owner ?? '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 采购概览卡片（2026-08-22 采购模块 Step 3）── */}
      <PurchaseSummaryCard projectId={params.id} />

      {/* ── 费用报销卡片（F3-R2：报销单+明细+审批流）── */}
      <ExpenseClaimCard projectId={params.id} myRole={project.myRole} me={me} />

      {/* ── 项目成员卡片区（P0-8）── */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Users className="h-4 w-4" />
              项目成员
              <Badge variant="secondary" className="font-normal">
                {members.length}
              </Badge>
            </h2>
            {project.can.edit && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setBoardOpen(true)}>
                  <ClipboardList className="mr-1 h-3.5 w-3.5" />
                  交付物看板
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMemberPickerOpen(true)}
                >
                  <UserPlus className="mr-1 h-3.5 w-3.5" />
                  添加成员
                </Button>
              </div>
            )}
          </div>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无成员</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <ImAvatar name={m.name} className="h-10 w-10 text-sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {MEMBER_ROLE_TEXT[m.role] ?? m.role}
                      {m.title ? ` · ${m.title}` : ''}
                    </div>
                  </div>
                  {project.can.edit && m.role !== 'OWNER' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground hover:text-destructive"
                      disabled={removingId === m.userId}
                      onClick={() => handleRemoveMember(m.userId)}
                      title="移除成员"
                    >
                      {removingId === m.userId ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UserMinus className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 阶段根树（§8.2① PhaseTree 契约组件）；历史台账项目改渲染档案卡 ── */}
      {isLegacy ? (
        <LegacyProjectCard project={project} />
      ) : (
        <div className="space-y-2">
          {/* 项目文件（条目 + 状态） */}
          <h2 className="flex items-center gap-2 text-base font-semibold">
            项目文件
            <Badge variant="secondary" className="font-normal">
              {projectFiles.length} 个条目
            </Badge>
          </h2>
          {projectFiles.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              暂无文件条目，前往「文件目录」创建
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {projectFiles.map((f) => {
                const st = FILE_STATUS[f.status] ?? f.status
                const statusCls =
                  f.status === 'APPROVED'
                    ? 'bg-emerald-100 text-emerald-700'
                    : f.status === 'REJECTED'
                      ? 'bg-red-100 text-red-600'
                      : f.status === 'WAITING'
                        ? 'bg-slate-100 text-slate-600'
                        : 'bg-blue-100 text-blue-700'
                return (
                  <div
                    key={f.id}
                    onClick={() =>
                      router.push(`/files?projectId=${projectId}&requirementId=${f.id}`)
                    }
                    className="flex cursor-pointer items-start justify-between gap-2 rounded-lg border p-3 transition-colors hover:bg-muted/40"
                    title="点击查看文件详情 / 提交"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{f.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {f.catalog.name}
                        {f.owner?.name ? ` · ${f.owner.name}` : ''}
                        {f.files[0] ? ` · v${f.files[0].version}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                          statusCls,
                        )}
                      >
                        {st}
                      </span>
                      {f.status === 'WAITING' &&
                        !!me &&
                        (me.role === 'ADMIN' || f.ownerId === me.id || f.reviewerId === me.id) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px] text-red-600 hover:text-red-700"
                            onClick={(e) => {
                              e.stopPropagation()
                              setFileReqDeleting(f)
                            }}
                            title="删除该条目（仅未提交状态可删，不可恢复）"
                          >
                            <Trash2 className="mr-0.5 h-3 w-3" />
                            删除
                          </Button>
                        )}
                      {(f.status === 'WAITING' || f.status === 'REJECTED') &&
                        f.permissions?.upload === true && (
                          <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                            去提交
                          </span>
                        )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <h2 className="flex items-center gap-2 text-base font-semibold">
            流程阶段
            <Badge variant="secondary" className="font-normal">
              {tree.phases.length} 个阶段
            </Badge>
          </h2>
          <PhaseTree projectId={projectId} />
        </div>
      )}

      {/* ── 编辑弹窗 ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑项目信息</DialogTitle>
            <DialogDescription>
              {project.code} · 基本信息维护（PATCH /api/projects/:id）
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="p-name">
                项目名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={200}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="p-location">施工地点</Label>
                <Input
                  id="p-location"
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  maxLength={200}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="p-amount">合同金额（元）</Label>
                <Input
                  id="p-amount"
                  type="number"
                  min={0}
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="p-desc">备注说明</Label>
              <Textarea
                id="p-desc"
                rows={3}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button disabled={saving || form.name.trim() === ''} onClick={saveEdit}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 删除项目二次确认（删除工程第 2 棒）── */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除项目「${project.name}」`}
        description={
          '将永久删除：全部阶段与任务（含修订/批注/评论）、文件目录与文件条目（含已上传文件）、相关待办/通知/催办，并解除项目群成员关联（会话记录保留）。存在采购订单时将被拒绝（财务审计链）。该操作不可恢复。'
        }
        confirmText="永久删除"
        destructive
        loading={deleting}
        onConfirm={doDeleteProject}
      />

      {/* ── 删除文件条目二次确认（删除工程第 4 棒）── */}
      <ConfirmDialog
        open={fileReqDeleting !== null}
        onOpenChange={(v) => !v && setFileReqDeleting(null)}
        title={`删除文件条目「${fileReqDeleting?.name ?? ''}」`}
        description={
          '仅未提交（待提交）条目可删除；其关联文件、待办与通知将一并清理。该操作不可恢复。'
        }
        confirmText="删除"
        destructive
        loading={fileReqDeleteBusy}
        onConfirm={doDeleteFileReq}
      />

      {/* ── 添加成员选人弹窗（P0-8）── */}
      <MemberPicker
        open={memberPickerOpen}
        onOpenChange={setMemberPickerOpen}
        mode="multi"
        title="添加项目成员"
        description="选择要加入该项目的成员（将同步拉入项目群）"
        confirmText={(n) => (n > 0 ? `添加成员（${n} 人）` : '添加成员')}
        excludeIds={members.map((m) => m.userId)}
        loading={addingMember}
        onConfirm={handleAddMembers}
      />

      {/* ── 交付物看板弹窗（2026-08-21 个人交付物）── */}
      <DeliverableBoard
        projectId={projectId}
        open={boardOpen}
        onOpenChange={setBoardOpen}
      />

      {/* ── 权限矩阵弹窗（P1-2）── */}
      <PermissionMatrixDialog
        projectId={projectId}
        projectCode={project.code}
        open={permOpen}
        onOpenChange={setPermOpen}
      />

      {/* ── AI 汇总弹窗（S4）── */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" /> AI 项目汇总
            </DialogTitle>
            <DialogDescription>
              {aiSummary?.projectLabel ?? project.code + ' ' + project.name}
            </DialogDescription>
          </DialogHeader>
          {aiBusy ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> AI 正在汇总项目状态…
            </div>
          ) : (
            <div className="space-y-3">
              {aiSummary?.stats && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {typeof aiSummary.stats.progressPercent === 'number' && (
                    <Badge variant="secondary">总进度 {aiSummary.stats.progressPercent}%</Badge>
                  )}
                  {typeof aiSummary.stats.phaseCount === 'number' && (
                    <Badge variant="secondary">阶段 {aiSummary.stats.phaseCount}</Badge>
                  )}
                  {aiSummary.stats.taskStats &&
                    Object.entries(aiSummary.stats.taskStats).map(([k, v]) => (
                      <Badge key={k} variant="outline">{label(TASK_STATUS, k)} {v}</Badge>
                    ))}
                  {aiSummary.stats.fileStats &&
                    Object.entries(aiSummary.stats.fileStats).map(([k, v]) => (
                      <Badge key={k} variant="outline">{label(FILE_STATUS, k)} {v}</Badge>
                    ))}
                </div>
              )}
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {aiSummary?.summary ?? '未返回内容'}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── 视图入口（五视图从项目进入，侧边栏已去掉视图大类）── */}
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>项目视图</DialogTitle>
            <DialogDescription>选择视图查看「{project.name}」的项目数据</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            {[
              { name: '甘特图', href: '/views/gantt' },
              { name: '流程图', href: '/views/flow' },
              { name: '表格视图', href: '/views/table' },
              { name: '图表视图', href: '/views/charts' },
            ].map((v) => (
              <Button
                key={v.href}
                variant="outline"
                className="justify-start"
                onClick={() => {
                  setViewOpen(false)
                  router.push(`${v.href}?projectId=${projectId}`)
                }}
              >
                {v.name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 采购概览卡片（2026-08-22 采购模块 Step 3）：订单数 + 总金额（脱敏），点击进采购页 */
function PurchaseSummaryCard({ projectId }: { projectId: string }) {
  const router = useRouter()
  const { data } = useQuery({
    queryKey: ['purchase-summary', projectId],
    queryFn: () =>
      ApiService.get<{
        orders: { count: number; totalAmount: number | null; inTransit: number }
      }>(`/projects/${projectId}/purchase-summary`).then((r) => r.data),
  })

  if (!data) return null

  return (
    <Card
      className="cursor-pointer transition-shadow hover:shadow-md"
      onClick={() => router.push(`/purchase?projectId=${projectId}`)}
    >
      <CardContent className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <ShoppingCart className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold">采购</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.orders.count} 张订单
              {data.orders.inTransit > 0 && ` · ${data.orders.inTransit} 在途`}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">总金额</p>
          <p className="font-mono text-sm font-semibold">
            {data.orders.totalAmount == null
              ? '—'
              : `¥${Number(data.orders.totalAmount).toLocaleString('zh-CN')}`}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
