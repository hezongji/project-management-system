'use client'

/**
 * MobileProjectDetail —— 项目详情移动子树。
 * MobilePageHeader（返回 + 更多动作 Sheet）+ 概览竖排卡 + 成员/文件卡片流 + PhaseTree。
 * 弹窗全部留在页面层（Portal 渲染，桌面/移动共用），本组件只触发动作回调。
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  Archive,
  BarChart3,
  ClipboardList,
  Loader2,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserMinus,
  UserPlus,
} from 'lucide-react'
import { MobilePageHeader } from './page-header'
import { MobileCard } from './card'
import { MobileList, MobileListItem } from './list'
import { MobileStatusChip, type MobileChipTone } from './status-chip'
import { Sheet as MobileSheet } from '@/components/ui/sheet'
import { ProgressRing } from '@/components/projects/progress-ring'
import { ImAvatar } from '@/components/im/message-bubble'
import { PhaseTree } from '@/components/projects/phase-tree'
import { label, FILE_STATUS } from '@/lib/labels'
import type { TreeProject } from '@/types/project-tree'
import type { FileRequirementItem } from '@/types/files'

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: '进行中',
  ON_HOLD: '暂停',
  COMPLETED: '已完成',
  CANCELLED: '已作废',
}
const STATUS_TONE: Record<string, MobileChipTone> = {
  ACTIVE: 'info',
  ON_HOLD: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'danger',
}
const FILE_TONE: Record<string, MobileChipTone> = {
  APPROVED: 'success',
  REJECTED: 'danger',
  WAITING: 'default',
  REVIEWING: 'info',
  SUBMITTED: 'success',
}
const MEMBER_ROLE_TEXT: Record<string, string> = {
  OWNER: '负责人',
  MANAGER: '经理',
  MEMBER: '成员',
  VIEWER: '访客',
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('zh-CN') : '—'
const fmtAmount = (n: number | null) =>
  n === null ? '—' : '¥' + n.toLocaleString('zh-CN')

export interface MobileProjectDetailActions {
  edit: (() => void) | null
  permission: (() => void) | null
  view: () => void
  ai: (() => void) | null
  aiBusy: boolean
  archive: (() => void) | null
  archiving: boolean
  deleteProject: (() => void) | null
  board: (() => void) | null
  addMember: (() => void) | null
  removeMember: (userId: string) => void
  removingId: string | null
  deleteFileReq: (f: FileRequirementItem) => void
  goFiles: (requirementId: string) => void
}

export function MobileProjectDetail({
  project,
  fileSummary,
  isLegacy,
  members,
  phasesCount,
  projectFiles,
  me,
  actions,
  extraCards,
  legacyCard,
}: {
  project: TreeProject
  fileSummary: { required: number; approved: number; waiting?: number; rejected: number }
  isLegacy: boolean
  members: Array<{ userId: string; name: string; role: string; title?: string | null }>
  phasesCount: number
  projectFiles: FileRequirementItem[]
  me?: { id: string; role: string } | null
  actions: MobileProjectDetailActions
  extraCards?: React.ReactNode
  legacyCard?: React.ReactNode
}) {
  const router = useRouter()
  const [moreOpen, setMoreOpen] = React.useState(false)

  const run = (fn: (() => void) | null) => () => {
    if (!fn) return
    setMoreOpen(false)
    fn()
  }

  /* 更多动作清单（权限门控与桌面一致） */
  const actionRows: Array<{ key: string; icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; danger?: boolean }> = []
  if (actions.edit) actionRows.push({ key: 'edit', icon: Pencil, label: '编辑项目信息', onClick: run(actions.edit) })
  if (actions.permission) actionRows.push({ key: 'perm', icon: ShieldCheck, label: '权限矩阵', onClick: run(actions.permission) })
  if (actions.board) actionRows.push({ key: 'board', icon: ClipboardList, label: '交付物看板', onClick: run(actions.board) })
  actionRows.push({ key: 'view', icon: BarChart3, label: '项目视图（甘特/流程/表格）', onClick: run(actions.view) })
  if (actions.ai) actionRows.push({ key: 'ai', icon: Sparkles, label: actions.aiBusy ? 'AI 汇总中…' : 'AI 汇总', onClick: run(actions.ai) })
  if (actions.addMember) actionRows.push({ key: 'addm', icon: UserPlus, label: '添加成员', onClick: run(actions.addMember) })
  if (actions.archive) actionRows.push({ key: 'arch', icon: Archive, label: actions.archiving ? '归档中…' : '归档项目', onClick: run(actions.archive) })
  if (actions.deleteProject) actionRows.push({ key: 'del', icon: Trash2, label: '删除项目（不可恢复）', onClick: run(actions.deleteProject), danger: true })

  const canManageMembers = actions.addMember != null

  return (
    <div className="space-y-4 pb-4">
      <MobilePageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-sm font-semibold text-primary">{project.code}</span>
            <span className="truncate">{project.name}</span>
          </span>
        }
        onBack={() => router.back()}
        right={
          <button
            type="button"
            aria-label="更多操作"
            onClick={() => setMoreOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-md text-foreground active:bg-muted/60"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        }
      />

      {/* 概览竖排卡 */}
      <div className="px-3">
        <MobileCard>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold leading-snug">{project.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <MobileStatusChip
                  label={STATUS_TEXT[project.status] ?? project.status}
                  tone={STATUS_TONE[project.status] ?? 'default'}
                />
                {project.myRole && (
                  <MobileStatusChip
                    label={'我的角色：' + (project.myRole === 'ADMIN' ? '系统管理员' : MEMBER_ROLE_TEXT[project.myRole] ?? project.myRole)}
                    tone="default"
                  />
                )}
                {project.isArchived && <MobileStatusChip label="已归档" tone="default" />}
              </div>
            </div>
            {isLegacy ? (
              <MobileStatusChip label="历史台账" tone="default" />
            ) : (
              <div className="shrink-0 text-center">
                <ProgressRing value={project.progress} size={44} stroke={4} />
                <p className="mt-0.5 text-[10px] text-muted-foreground">总进度</p>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">合同金额</div>
              <div className="text-sm font-medium tabular-nums">{fmtAmount(project.amount)}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">合同号</div>
              <div className="truncate text-sm font-medium">{project.contractNo || '—'}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">施工地点</div>
              <div className="truncate text-sm font-medium">{project.location || '—'}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">客户</div>
              <div className="truncate text-sm font-medium">{project.customer?.name || '—'}</div>
            </div>
            <div className="col-span-2 space-y-0.5">
              <div className="text-xs text-muted-foreground">计划周期</div>
              <div className="text-sm font-medium">
                {fmtDate(project.plannedStart)} ~ {fmtDate(project.plannedEnd)}
              </div>
            </div>
            {!isLegacy && (
              <div className="col-span-2 space-y-0.5">
                <div className="text-xs text-muted-foreground">必需文件</div>
                <div className="text-sm font-medium">
                  {fileSummary.approved}/{fileSummary.required} 通过
                  {fileSummary.rejected > 0 && (
                    <span className="text-destructive">（{fileSummary.rejected} 驳回）</span>
                  )}
                </div>
              </div>
            )}
          </div>
       
        </MobileCard>
      </div>

      {/* 页面注入的附加卡（采购概览 / 费用报销，桌面同款组件直接复用） */}
      {extraCards && <div className="px-3">{extraCards}</div>}

      {/* 项目成员 */}
      <div className="px-3">
        <MobileCard
          title={
            <span className="flex items-center gap-1.5">
              项目成员 <span className="text-xs font-normal text-muted-foreground">{members.length}</span>
            </span>
          }
          extra={
            canManageMembers ? (
              <button
                type="button"
                className="-my-3 flex h-11 items-center gap-1 text-xs text-primary"
                onClick={actions.addMember ?? undefined}
              >
                <UserPlus className="h-4 w-4" /> 添加
              </button>
            ) : undefined
          }
        >
          {members.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无成员</p>
          ) : (
            <MobileList
              items={members}
              keyOf={(m) => m.userId}
              renderItem={(m) => (
                <MobileListItem
                  avatar={<ImAvatar name={m.name} className="h-10 w-10 text-sm" />}
                  title={m.name}
                  subtitle={(MEMBER_ROLE_TEXT[m.role] ?? m.role) + (m.title ? ' · ' + m.title : '')}
                  right={
                    canManageMembers && m.role !== 'OWNER' ? (
                      <button
                        type="button"
                        aria-label={'移除成员 ' + m.name}
                        disabled={actions.removingId === m.userId}
                        onClick={() => actions.removeMember(m.userId)}
                        className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
                      >
                        {actions.removingId === m.userId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <UserMinus className="h-4 w-4" />
                        )}
                      </button>
                    ) : undefined
                  }
                />
              )}
            />
          )}
        </MobileCard>
      </div>

      {isLegacy ? (
        <div className="px-3">{legacyCard}</div>
      ) : (
        <>
          {/* 项目文件条目 */}
          <div className="space-y-2 px-3">
            <h2 className="flex items-center gap-2 px-1 text-base font-semibold">
              项目文件
              <span className="text-xs font-normal text-muted-foreground">{projectFiles.length} 个条目</span>
            </h2>
            {projectFiles.length === 0 ? (
              <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
                暂无文件条目，前往「文件目录」创建
              </div>
            ) : (
              <MobileList
                items={projectFiles}
                keyOf={(f) => f.id}
                renderItem={(f) => {
                  const canDeleteThis =
                    f.status === 'WAITING' &&
                    !!me &&
                    (me.role === 'ADMIN' || f.ownerId === me.id || f.reviewerId === me.id)
                  const canUpload =
                    (f.status === 'WAITING' || f.status === 'REJECTED') && f.permissions?.upload === true
                  return (
                    <MobileListItem
                      title={
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">{f.name}</span>
                          {canUpload && (
                            <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                              去提交
                            </span>
                          )}
                        </span>
                      }
                      subtitle={
                        f.catalog.name +
                        (f.owner?.name ? ' · ' + f.owner.name : '') +
                        (f.files[0] ? ' · v' + f.files[0].version : '')
                      }
                      status={
                        <MobileStatusChip
                          label={label(FILE_STATUS, f.status)}
                          tone={FILE_TONE[f.status] ?? 'default'}
                        />
                      }
                      right={
                        canDeleteThis ? (
                          <button
                            type="button"
                            aria-label="删除该条目"
                            onClick={() => actions.deleteFileReq(f)}
                            className="flex h-11 w-11 items-center justify-center rounded-md text-destructive active:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            aria-label="查看文件"
                            onClick={() => actions.goFiles(f.id)}
                            className="h-11 shrink-0 px-2 text-xs text-primary active:opacity-70"
                          >
                            查看
                          </button>
                        )
                      }
                    />
                  )
                }}
              />
            )}

            {/* 流程阶段（复用 PhaseTree 契约组件） */}
            <h2 className="flex items-center gap-2 px-1 pt-1 text-base font-semibold">
              流程阶段
              <span className="text-xs font-normal text-muted-foreground">{phasesCount} 个阶段</span>
            </h2>
            <PhaseTree projectId={project.id} />
          </div>
        </>
      )}

      {/* 更多动作底部抽屉 */}
      <MobileSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="项目操作">
        <div className="divide-y">
          {actionRows.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              className={
                'flex min-h-12 w-full items-center gap-3 px-1 py-2 text-left text-sm active:bg-muted/60 ' +
                (a.danger ? 'text-destructive' : 'text-foreground')
              }
            >
              <a.icon className={'h-4 w-4 shrink-0 ' + (a.danger ? '' : 'text-muted-foreground')} />
              {a.label}
            </button>
          ))}
        </div>
      </MobileSheet>
    </div>
  )
}
