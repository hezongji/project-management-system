'use client'

/**
 * 文件条目列表（阶段下钻页右区，§8.2② / §7.7 条目对象）
 *
 * 该阶段 code 过滤的条目 + 状态徽章 + 版本时间线（files 版本数组）。
 * [上传] [审核] 为占位按钮：按条目 permissions.upload / approve 显隐，
 * 文件上传/审核交互由 P2（文件目录管理）交付，此处仅展示。
 */

import { ChevronDown, ChevronRight, FileText, UploadCloud, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { FileRequirementDto, FileStatus } from '@/types/phase'

const STATUS_BADGE: Record<FileStatus, { label: string; cls: string }> = {
  WAITING: { label: '待提交', cls: 'bg-slate-100 text-slate-600' },
  SUBMITTED: { label: '已提交', cls: 'bg-blue-100 text-blue-700' },
  REVIEWING: { label: '审核中', cls: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '已驳回', cls: 'bg-red-100 text-red-700' },
  NA: { label: '不适用', cls: 'bg-zinc-100 text-zinc-500' },
  OBSOLETED: { label: '已作废', cls: 'bg-zinc-200 text-zinc-500 line-through' },
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

interface FileRequirementListProps {
  requirements: FileRequirementDto[]
}

export function FileRequirementList({ requirements }: FileRequirementListProps) {
  const approved = requirements.filter((r) => r.status === 'APPROVED').length

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">
          文件条目（{requirements.length}）
        </h2>
        <span className="text-xs text-muted-foreground">
          已通过 {approved}/{requirements.length}
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {requirements.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            该阶段暂无文件条目
          </div>
        ) : (
          requirements.map((req) => <RequirementCard key={req.id} req={req} />)
        )}
      </div>
    </div>
  )
}

function RequirementCard({ req }: { req: FileRequirementDto }) {
  const [expanded, setExpanded] = useState(false)
  const badge = STATUS_BADGE[req.status] ?? STATUS_BADGE.WAITING
  const latest = req.files[0] ?? null

  return (
    <div className="rounded-md border bg-background p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          aria-label={expanded ? '收起版本' : '展开版本'}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium" title={req.name}>
              {req.name}
            </span>
            {!req.required && (
              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">非必需</span>
            )}
            <span
              className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.cls)}
            >
              {badge.label}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{req.code ?? '—'}</span>
            <span>责任人：{req.owner?.name ?? '—'}</span>
            {req.purpose && <span>用途：{req.purpose}</span>}
            {req.dueDate && <span>截止 {req.dueDate.slice(0, 10)}</span>}
          </div>

          {/* 版本摘要 + 展开时间线 */}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {latest ? (
              <span>
                最新版 v{latest.version} · {latest.uploadedBy?.name ?? '—'} · {formatSize(latest.size)}
              </span>
            ) : (
              <span className="italic opacity-70">尚未上传任何版本</span>
            )}
          </div>

          {expanded && (
            <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2">
              {req.files.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">无版本记录</div>
              ) : (
                req.files.map((f, i) => (
                  <div key={f.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold',
                        i === 0 ? 'bg-primary/10 text-primary' : 'bg-muted',
                      )}
                    >
                      {f.version}
                    </span>
                    <span className="truncate" title={f.originalName}>
                      {f.name}
                    </span>
                    <span className="ml-auto shrink-0">
                      {f.uploadedBy?.name ?? '—'} · {formatSize(f.size)} ·{' '}
                      {f.createdAt.slice(0, 10)}
                    </span>
                  </div>
                ))
              )}
              <div className="pt-0.5 text-[11px] text-muted-foreground">
                审核人：{req.reviewer?.name ?? '阶段负责人（默认）'}
              </div>
            </div>
          )}

          {/* 占位操作（P2 文件交互交付后替换为真实上传/审核） */}
          {(req.permissions.upload || req.permissions.approve) && (
            <div className="mt-2 flex gap-2">
              {req.permissions.upload && (
                <Button size="sm" variant="outline" disabled title="文件上传由 P2 阶段交付" className="h-7 text-xs">
                  <UploadCloud className="mr-1 h-3.5 w-3.5" />
                  上传
                </Button>
              )}
              {req.permissions.approve && (
                <Button size="sm" variant="outline" disabled title="文件审核由 P2 阶段交付" className="h-7 text-xs">
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                  审核
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
