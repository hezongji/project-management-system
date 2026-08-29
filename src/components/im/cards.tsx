'use client'

/**
 * 卡片消息渲染 —— 依据《开发文档-项目管理系统重构》§8.2⑥ / §9.3
 *
 * TASK_CARD / PHASE_CARD / REPORT / ISSUE 四类卡片式气泡，解析 content JSON 渲染。
 * - TASK_CARD 点击 → /projects/:projectId/tasks/:taskId
 * - PHASE_CARD 点击 → /projects/:projectId/phases/:phaseId
 * - ISSUE / REPORT：卡片内渲染全部字段即可用，ISSUE 点击弹详情（不强制跳转）
 * - projectId 解析优先级：卡片 JSON 内的 projectId > 会话 projectId（缺一不可时才禁用跳转）
 * - 字段缺失时按契约渲染已有字段，绝不因缺字段崩溃
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, useConfirm } from '@/components/ui/confirm-dialog' // ConfirmDialog 经 confirm.render 渲染
import { useToast } from '@/components/ui/use-toast'
import { api } from '@/services/api-instance'
import { useAuthStore } from '@/store/auth'
import { cn } from '@/lib/utils'
import {
  type TaskCardData,
  type PhaseCardData,
  type IssueCardData,
  type ReportCardData,
  safeParseJson,
} from './utils'
import { AlertTriangle, ClipboardList, Layers, FileText, Trash2 } from 'lucide-react'

const STATUS_LABEL: Record<string, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  REVIEW: '待评审',
  DONE: '已完成',
  CANCELLED: '已取消',
  NOT_STARTED: '未开始',
  PAUSED: '已暂停',
  SKIPPED: '已跳过',
  OPEN: '未解决',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
  APPROVED: '已通过',
  REJECTED: '已驳回',
}

const URGENCY_LABEL: Record<string, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
}

function statusVariant(s?: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  const v = (s || '').toUpperCase()
  if (['DONE', 'RESOLVED', 'CLOSED', 'APPROVED', 'SKIPPED'].includes(v)) return 'secondary'
  if (['CANCELLED', 'REJECTED'].includes(v)) return 'outline'
  if (['OPEN', 'IN_PROGRESS'].includes(v)) return 'default'
  return 'default'
}

function urgencyVariant(s?: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  const v = (s || '').toUpperCase()
  if (['HIGH', 'URGENT'].includes(v)) return 'destructive'
  if (v === 'MEDIUM') return 'default'
  return 'secondary'
}

function CardShell({
  icon,
  tag,
  title,
  badge,
  children,
  clickable,
  onClick,
}: {
  icon: React.ReactNode
  tag: string
  title?: string
  badge?: React.ReactNode
  children?: React.ReactNode
  clickable?: boolean
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'w-60 rounded-lg border bg-background p-3 text-left shadow-sm',
        clickable && 'cursor-pointer transition-colors hover:border-primary/60 hover:bg-accent/40',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span>{tag}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      {title !== undefined && (
        <div className="mt-1.5 line-clamp-2 text-sm font-medium text-foreground">{title || '（无标题）'}</div>
      )}
      {children}
      {clickable && (
        <div className="mt-2 text-xs font-medium text-primary">查看详情 →</div>
      )}
    </div>
  )
}

function TaskCard({ data, projectId, onGo }: { data: TaskCardData | null; projectId?: string | null; onGo: (path: string) => void }) {
  const pid = data?.projectId || projectId || null
  const clickable = !!(pid && data?.taskId)
  return (
    <CardShell
      icon={<ClipboardList className="h-3.5 w-3.5" />}
      tag="任务卡片"
      title={data?.title}
      badge={data?.status ? <Badge variant={statusVariant(data.status)} className="h-4 px-1.5 text-[10px]">{STATUS_LABEL[data.status] ?? data.status}</Badge> : undefined}
      clickable={clickable}
      onClick={
        clickable && data?.taskId
          ? () => {
              // 跨页定位：携带来源标签，目标页重定向后以 ?focus=taskId 高亮看板卡片
              const base = `/projects/${pid}/tasks/${data.taskId}`
              onGo(`${base}${base.includes('?') ? '&' : '?'}src=${encodeURIComponent('消息卡片')}`)
            }
          : undefined
      }
    >
      {data?.phaseName && <div className="mt-1 text-xs text-muted-foreground">所属阶段：{data.phaseName}</div>}
    </CardShell>
  )
}

function PhaseCard({ data, projectId, onGo }: { data: PhaseCardData | null; projectId?: string | null; onGo: (path: string) => void }) {
  const pid = data?.projectId || projectId || null
  const clickable = !!(pid && data?.phaseId)
  const progress = typeof data?.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : null
  return (
    <CardShell
      icon={<Layers className="h-3.5 w-3.5" />}
      tag="阶段卡片"
      title={data?.name}
      badge={progress !== null ? <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{progress}%</Badge> : undefined}
      clickable={clickable}
      onClick={clickable && data?.phaseId ? () => onGo(`/projects/${pid}/phases/${data.phaseId}`) : undefined}
    >
      {data?.projectName && <div className="mt-1 text-xs text-muted-foreground">项目：{data.projectName}</div>}
      {progress !== null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
        </div>
      )}
    </CardShell>
  )
}

function IssueCard({ data, onOpen }: { data: IssueCardData | null; onOpen: () => void }) {
  return (
    <CardShell
      icon={<AlertTriangle className="h-3.5 w-3.5" />}
      tag="问题上报"
      title={data?.title}
      badge={
        <span className="flex items-center gap-1">
          {data?.status && <Badge variant={statusVariant(data.status)} className="h-4 px-1.5 text-[10px]">{STATUS_LABEL[data.status] ?? data.status}</Badge>}
          {data?.urgency && <Badge variant={urgencyVariant(data.urgency)} className="h-4 px-1.5 text-[10px]">{URGENCY_LABEL[data.urgency] ?? data.urgency}</Badge>}
        </span>
      }
      clickable
      onClick={onOpen}
    >
      {data?.assignee && <div className="mt-1 text-xs text-muted-foreground">负责人：{data.assignee}</div>}
      {data?.desc && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{data.desc}</div>}
    </CardShell>
  )
}

function ReportCard({ data }: { data: ReportCardData | null }) {
  return (
    <CardShell
      icon={<FileText className="h-3.5 w-3.5" />}
      tag="工作汇报"
      title={data?.kind ? `${data.kind} 汇报` : '工作汇报'}
      badge={data?.date ? <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{data.date}</Badge> : undefined}
    >
      {data?.done && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">完成：</span>
          {data.done}
        </div>
      )}
      {data?.plan && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">计划：</span>
          {data.plan}
        </div>
      )}
      {data?.needHelp && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">需协助：</span>
          {data.needHelp}
        </div>
      )}
    </CardShell>
  )
}

/**
 * 卡片消息分发器：根据 type 解析 content JSON 并渲染对应卡片。
 * onNavigate 缺省时内部 router.push（便于单测注入）。
 */
export function MessageCard({
  type,
  content,
  projectId,
  onNavigate,
  mine,
}: {
  type: string
  content: string
  projectId?: string | null
  onNavigate?: (path: string) => void
  /** 当前消息是否为自己发送（ISSUE 卡片删除按钮的上报人判定） */
  mine?: boolean
}) {
  const router = useRouter()
  const go = (path: string) => {
    if (onNavigate) onNavigate(path)
    else router.push(path)
  }

  switch (type) {
    case 'TASK_CARD':
      return <TaskCard data={safeParseJson<TaskCardData>(content)} projectId={projectId} onGo={go} />
    case 'PHASE_CARD':
      return <PhaseCard data={safeParseJson<PhaseCardData>(content)} projectId={projectId} onGo={go} />
    case 'ISSUE':
      return (
        <IssueWithDetail
          data={safeParseJson<IssueCardData>(content)}
          mine={mine}
        />
      )
    case 'REPORT':
      return <ReportCard data={safeParseJson<ReportCardData>(content)} />
    default:
      // 未知卡片类型：按纯文本渲染，避免发散乱码
      return <span className="whitespace-pre-wrap break-words text-sm">{content}</span>
  }
}

/** ISSUE 卡片 + 点击弹详情（images 数组可预览；删除工程第 6 棒：上报人/ADMIN 可删 OPEN 问题） */
function IssueWithDetail({ data, mine }: { data: IssueCardData | null; mine?: boolean }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const confirm = useConfirm()
  const user = useAuthStore((s) => s.user)

  // 删除条件：未解决（OPEN）+（上报人=消息发送人 或 ADMIN）；服务端终审
  const canDelete =
    !!data?.issueId &&
    data?.status !== 'RESOLVED' &&
    (mine || user?.role === 'ADMIN')

  const handleDelete = () => {
    if (!data?.issueId) return
    confirm.ask(
      '删除问题上报',
      `将永久删除问题「${data?.title || '未命名'}」及其会话全部消息，关联任务不删除；操作不可恢复，将记入审计日志。`,
      async () => {
        try {
          await api.delete(`/issues/${data.issueId}`)
          toast({ title: '问题已删除' })
          setOpen(false)
          // 会话已删，当前视图成孤儿 → 回消息列表（无实时事件，列表刷新后消失）
          router.push('/messages')
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
    <>
      <IssueCard data={data} onOpen={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{data?.title || '问题详情'}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              {data?.urgency && <Badge variant={urgencyVariant(data.urgency)}>紧急度：{URGENCY_LABEL[data.urgency] ?? data.urgency}</Badge>}
              {data?.status && <Badge variant={statusVariant(data.status)}>状态：{STATUS_LABEL[data.status] ?? data.status}</Badge>}
              {data?.assignee && <span className="text-xs">负责人：{data.assignee}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
            {data?.desc && <p className="whitespace-pre-wrap text-muted-foreground">{data.desc}</p>}
            {Array.isArray(data?.images) && data.images.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {data.images.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt={`问题图片 ${i + 1}`} className="h-24 w-full rounded object-cover" />
                ))}
              </div>
            )}
          </div>
          {canDelete && (
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除问题
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {confirm.render}
    </>
  )
}

