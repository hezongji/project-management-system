'use client'

/**
 * 文件条目详情 —— §8.2④（版本时间线 + 上传 + 下载/预览）
 *
 * P2-1 条目详情抽屉的内容体：由 FileRequirementDetail 承载。
 * 数据源：父组件传入条目（含 files 版本数组 + permissions），
 * 上传成功后本地追加新版本并回调 onChanged 通知父组件失效缓存。
 *
 * 权限驱动显隐（§4.7）：上传=permissions.upload；下载=permissions.download
 * （缺省回退 view，因 FILE_REQ 的 view/download 终审同源，见 lib/permission.ts）；
 * 预览=view。服务端 requireCan 终审。
 */

import { useCallback, useEffect, useState } from 'react'
import { FileText, Hash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { FileService } from '@/services/file'
import { VersionTimeline } from './version-timeline'
import { FileUploadButton } from './file-upload-button'
import { FilePreviewDialog } from './file-preview-dialog'
import type { FileRequirementDetailInput, UploadedFileDto } from '@/types/file'
import type { FileStatus, FileVersionDto } from '@/types/phase'

const STATUS_BADGE: Record<FileStatus, { label: string; cls: string }> = {
  WAITING: { label: '待提交', cls: 'bg-slate-100 text-slate-600' },
  SUBMITTED: { label: '已提交', cls: 'bg-blue-100 text-blue-700' },
  REVIEWING: { label: '审核中', cls: 'bg-amber-100 text-amber-700' },
  APPROVED: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '已驳回', cls: 'bg-red-100 text-red-700' },
  NA: { label: '不适用', cls: 'bg-zinc-100 text-zinc-500' },
  OBSOLETED: { label: '已作废', cls: 'bg-zinc-200 text-zinc-500 line-through' },
}

interface FileRequirementDetailProps {
  requirement: FileRequirementDetailInput
  onChanged?: () => void
}

export function FileRequirementDetail({ requirement, onChanged }: FileRequirementDetailProps) {
  const { toast } = useToast()
  const [files, setFiles] = useState<FileVersionDto[]>(requirement.files ?? [])
  const [previewFile, setPreviewFile] = useState<FileVersionDto | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 抽屉切换到另一条目时同步本地版本数组（按 version 倒序，最新在前）
  useEffect(() => {
    setFiles([...(requirement.files ?? [])].sort((a, b) => b.version - a.version))
  }, [requirement])

  const badge = STATUS_BADGE[requirement.status] ?? STATUS_BADGE.WAITING
  const canUpload = requirement.permissions.upload === true
  // FILE_REQ 的 view/download 终审同源（lib/permission.ts scopeFinalize），缺省回退 view
  const canView = requirement.permissions.view === true
  const canDownload = requirement.permissions.download === true || canView

  const handleUploaded = useCallback(
    (uploaded: UploadedFileDto) => {
      const newVersion: FileVersionDto = {
        id: uploaded.id,
        name: uploaded.name,
        originalName: uploaded.originalName,
        size: uploaded.size,
        mimeType: uploaded.mimeType,
        version: uploaded.version,
        uploadedById: uploaded.uploadedById ?? '',
        uploadedBy: uploaded.uploadedBy ?? null,
        createdAt: uploaded.createdAt,
      }
      setFiles((prev) => {
        const rest = prev.filter((f) => f.id !== uploaded.id)
        return [newVersion, ...rest].sort((a, b) => b.version - a.version)
      })
      onChanged?.()
    },
    [onChanged],
  )

  const handleDownload = useCallback(
    async (file: FileVersionDto) => {
      setBusyId(file.id)
      try {
        await FileService.download(file.id, file.originalName || file.name)
        toast({ title: '开始下载', description: file.originalName || file.name })
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
          (err as Error).message
        toast({ title: '下载失败', description: msg, variant: 'destructive' })
      } finally {
        setBusyId(null)
      }
    },
    [toast],
  )

  return (
    <div className="space-y-4">
      {/* 头部：名称 / 编号 / 状态 */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-base font-semibold" title={requirement.name}>
              {requirement.name}
            </h3>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', badge.cls)}>
            {badge.label}
          </span>
        </div>
        {requirement.code && (
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Hash className="h-3 w-3" />
            <span className="font-mono">{requirement.code}</span>
          </div>
        )}
      </div>

      {/* 上传 */}
      <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {files.length > 0 ? (
            <span>已上传 {files.length} 个版本，最新 v{files[0]?.version ?? '-'}</span>
          ) : (
            <span>尚未上传文件</span>
          )}
        </div>
        <FileUploadButton
          requirementId={requirement.id}
          canUpload={canUpload}
          onUploaded={handleUploaded}
        />
      </div>

      {/* 版本时间线 */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          版本时间线
        </h4>
        <VersionTimeline
          files={files}
          canDownload={canDownload}
          canPreview={canView}
          busyId={busyId}
          onDownload={handleDownload}
          onPreview={(f) => setPreviewFile(f)}
        />
      </div>

      <FilePreviewDialog
        file={previewFile}
        open={previewFile !== null}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  )
}
