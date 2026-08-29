'use client'

/**
 * 版本时间线 —— §8.2④ 条目详情（files 数组：每版显示 version/uploadedBy/size/createdAt）
 *
 * 纯展示组件：倒序排列（最新版在前，与 GET /api/phases/:id 的 files orderBy
 * version desc 一致）。行内 [下载] [预览] [删除] 按钮由权限驱动（父组件传
 * canDownload/canPreview/canDelete + 回调）；sha256 以短哈希展示、title 悬浮完整值（§7.7 校验留痕）。
 */

import { FileText, Download, Eye, ChevronDown, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { shortChecksum } from '@/types/file'
import type { FileVersionDto } from '@/types/phase'

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

export function isPreviewable(mimeType: string): boolean {
  const m = mimeType.toLowerCase()
  return m.startsWith('image/') || m === 'application/pdf'
}

interface VersionTimelineProps {
  files: FileVersionDto[]
  canDownload: boolean
  canPreview: boolean
  /** 行级删除权限（删除工程第 4 棒）：uploader 本人 / 条目审核人 / ADMIN，由父组件判定 */
  canDelete?: (file: FileVersionDto) => boolean
  busyId?: string | null
  onDownload: (file: FileVersionDto) => void
  onPreview: (file: FileVersionDto) => void
  /** 删除回调（含确认弹窗与提示，由父组件实现；服务端终审） */
  onDelete?: (file: FileVersionDto) => void
}

export function VersionTimeline({
  files,
  canDownload,
  canPreview,
  canDelete,
  busyId,
  onDownload,
  onPreview,
  onDelete,
}: VersionTimelineProps) {
  const [expanded, setExpanded] = useState(false)

  if (files.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        尚未上传任何版本
      </div>
    )
  }

  const visible = expanded ? files : files.slice(0, 3)

  return (
    <div className="space-y-1.5">
      {visible.map((f, i) => {
        const checksum = (f as FileVersionDto & { checksum?: string | null }).checksum
        const latest = i === 0
        const busy = busyId === f.id
        return (
          <div
            key={f.id}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs',
              latest ? 'border-primary/30 bg-primary/5' : 'bg-muted/30',
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                latest ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
              title={`第 ${f.version} 版${latest ? '（最新）' : ''}`}
            >
              v{f.version}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium" title={f.originalName}>
                  {f.name}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                <span>{f.uploadedBy?.name ?? '—'}</span>
                <span>{formatSize(f.size)}</span>
                <span>{f.createdAt ? new Date(f.createdAt).toLocaleString('zh-CN') : ''}</span>
                {checksum && (
                  <span className="font-mono" title={`sha256: ${checksum}`}>
                    {shortChecksum(checksum)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {canPreview && isPreviewable(f.mimeType) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => onPreview(f)}
                  title="预览"
                >
                  <Eye className="mr-1 h-3.5 w-3.5" />
                  预览
                </Button>
              )}
              {canDownload && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => onDownload(f)}
                  title="下载"
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  下载
                </Button>
              )}
              {canDelete?.(f) && onDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                  disabled={busy}
                  onClick={() => onDelete(f)}
                  title="删除该版本（物理删除，不可恢复）"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              )}
            </div>
          </div>
        )
      })}

      {files.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
          {expanded ? '收起' : `展开全部 ${files.length} 个版本`}
        </button>
      )}
    </div>
  )
}
