import { cn } from '@/lib/utils'
import type { FileStatus } from '@/types/phase'

/**
 * 文件条目状态徽章（§5 FileStatusFm 七态 + §8.2 颜色约定）
 * 供条目列表 / 详情抽屉 / 审核操作区复用，避免多处维护同一映射。
 */
export const FILE_STATUS_META: Record<FileStatus, { label: string; cls: string }> = {
  WAITING: { label: '待提交', cls: 'bg-slate-100 text-slate-600' },
  SUBMITTED: { label: '已提交', cls: 'bg-blue-100 text-blue-700' },
  REVIEWING: { label: '审核中', cls: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '已驳回', cls: 'bg-red-100 text-red-700' },
  NA: { label: '不适用', cls: 'bg-zinc-100 text-zinc-500' },
  OBSOLETED: { label: '已作废', cls: 'bg-zinc-200 text-zinc-500 line-through' },
}

export function FileStatusBadge({
  status,
  className,
}: {
  status: FileStatus
  className?: string
}) {
  const meta = FILE_STATUS_META[status] ?? FILE_STATUS_META.WAITING
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
        meta.cls,
        className,
      )}
    >
      {meta.label}
    </span>
  )
}
