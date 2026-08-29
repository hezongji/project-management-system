'use client'

/**
 * RequirementDetailDrawer —— 条目详情抽屉（§8.2④ 行点开）
 *
 * 基本信息 + 真实操作：上传（版本递增）/ 预览 / 下载 / 通过 / 驳回。
 * 权限驱动显隐（§4.7）：上传=permissions.upload；下载=permissions.download（回退 view）；
 * 审核=permissions.approve。服务端 requireCan 终审。
 */

import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Loader2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { STATUS_BADGE, SCOPE_BADGE } from './badges'
import { FileUploadButton } from './file-upload-button'
import { VersionTimeline } from './version-timeline'
import { FilePreviewDialog } from './file-preview-dialog'
import { FileService } from '@/services/file'
import { api } from '@/services/api-instance'
import { ApiService } from '@/services/api'
import { globalConfirm } from '@/lib/global-confirm'
import type { FileRequirementItem } from '@/types/files'
import type { FileVersionDto } from '@/types/phase'

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

export function RequirementDetailDrawer({
  item,
  onClose,
  onChanged,
}: {
  item: FileRequirementItem | null
  onClose: () => void
  onChanged?: () => void
}) {
  const { toast } = useToast()
  const [files, setFiles] = useState<FileVersionDto[]>(item?.files ?? [])
  const [previewFile, setPreviewFile] = useState<FileVersionDto | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  // ★ 删除工程第 4 棒：条目删除中状态
  const [requirementDeleting, setRequirementDeleting] = useState(false)
  // ★ 删除工程第 4 棒：当前用户（行级删除权限近似显示，服务端终审）
  const { data: me } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () =>
      ApiService.get<{ id: string; role: string }>('/auth/me').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })
  // ★ AI 解读（S4）
  const [aiBusy, setAiBusy] = useState(false)
  const [aiExplanation, setAiExplanation] = useState<string | null>(null)
  const runExplain = async () => {
    if (!item || aiBusy) return
    setAiBusy(true)
    try {
      const res = await ApiService.post<{ requirement: unknown; explanation: string }>(
        '/ai/explain-file',
        { fileRequirementId: item.id },
        { timeout: 120_000 },
      )
      setAiExplanation(res.data?.explanation ?? 'AI 未返回解读内容')
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'AI 解读失败',
      })
    } finally {
      setAiBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (item) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

  // 切换条目时同步版本数组（按 version 倒序，最新在前）
  useEffect(() => {
    setFiles([...(item?.files ?? [])].sort((a, b) => b.version - a.version))
  }, [item])

  const handleUploaded = useCallback(
    (uploaded: {
      id: string
      name: string
      originalName?: string
      size: number
      mimeType?: string
      version: number
      uploadedById?: string
      uploadedBy?: { id: string; name: string } | null
      createdAt: string
    }) => {
      const newVersion: FileVersionDto = {
        id: uploaded.id,
        name: uploaded.name,
        originalName: uploaded.originalName ?? uploaded.name,
        size: uploaded.size,
        mimeType: uploaded.mimeType ?? '',
        version: uploaded.version,
        uploadedById: uploaded.uploadedById ?? '',
        uploadedBy: uploaded.uploadedBy ?? null,
        createdAt: uploaded.createdAt,
      }
      setFiles((prev) =>
        [newVersion, ...prev.filter((f) => f.id !== uploaded.id)].sort((a, b) => b.version - a.version),
      )
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

  // 删除工程第 4 棒：删除单个文件版本（uploader 本人 / 条目审核人 / ADMIN；服务端终审）
  const handleDeleteFile = useCallback(
    async (file: FileVersionDto) => {
      const confirmed = await globalConfirm(
        `确认删除文件「${file.originalName || file.name}」（第 v${file.version} 版）？删除后不可恢复，访问记录将一并清除。`,
        { title: '删除文件', confirmText: '删除', destructive: true },
      )
      if (!confirmed) return
      setBusyId(file.id)
      try {
        await api.delete(`/files/${file.id}`)
        setFiles((prev) => prev.filter((f) => f.id !== file.id))
        toast({ title: '已删除', description: file.originalName || file.name })
        onChanged?.()
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
          (err as Error).message
        toast({ title: '删除失败', description: msg, variant: 'destructive' })
      } finally {
        setBusyId(null)
      }
    },
    [toast, onChanged],
  )

  // 删除工程第 4 棒：删除整个条目（仅 WAITING；owner/reviewer/ADMIN；服务端终审）
  const handleDeleteRequirement = useCallback(async () => {
    if (!item) return
    const confirmed = await globalConfirm(
      `确认删除文件条目「${item.name}」？仅未提交（待提交）条目可删除，其关联文件、待办与通知将一并清理，不可恢复。`,
      { title: '删除文件条目', confirmText: '删除', destructive: true },
    )
    if (!confirmed) return
    setRequirementDeleting(true)
    try {
      await api.delete(`/file-requirements/${item.id}`)
      toast({ title: '条目已删除', description: item.name })
      onChanged?.()
      onClose()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (err as Error).message
      toast({ title: '删除失败', description: msg, variant: 'destructive' })
    } finally {
      setRequirementDeleting(false)
    }
  }, [item, toast, onChanged, onClose])

  const doReview = useCallback(
    async (action: 'approve' | 'reject') => {
      setReviewBusy(true)
      try {
        const comment = action === 'approve' ? '审核通过' : '审核驳回'
        await api.post(`/file-requirements/${item?.id}/${action}`, { comment })
        toast({ title: action === 'approve' ? '已通过' : '已驳回', description: comment })
        onChanged?.()
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
          (err as Error).message
        toast({ title: '操作失败', description: msg, variant: 'destructive' })
      } finally {
        setReviewBusy(false)
      }
    },
    [item, toast, onChanged],
  )

  if (!item) return null
  const status = STATUS_BADGE[item.status]
  const scope = SCOPE_BADGE[item.scope]
  const canUpload = item.permissions.upload === true
  const canDownload = item.permissions.download === true || item.permissions.view === true
  const canApprove = item.permissions.approve === true
  // 删除工程第 4 棒：近似显隐（服务端终审）——ADMIN / 条目责任人 / 审核人；仅 WAITING 可删
  const isAdmin = me?.role === 'ADMIN'
  const canDeleteRequirement =
    !!me && item.status === 'WAITING' && (isAdmin || item.ownerId === me.id || item.reviewerId === me.id)
  const canDeleteFile = (f: FileVersionDto) =>
    !!me && (isAdmin || f.uploadedById === me.id || item.reviewerId === me.id)

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col border-l bg-background shadow-xl">
        <div className="flex items-start justify-between border-b p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h2 className="truncate text-base font-semibold" title={item.name}>
                {item.name}
              </h2>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{item.code ?? '无编号'}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', status.cls)}>
                {status.label}
              </span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', scope.cls)}>
                {scope.label}
              </span>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* 基本信息 */}
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">基本信息</h3>
            <div className="rounded-md border p-3">
              <InfoRow label="目录" value={item.catalog.name} />
              <InfoRow label="责任人" value={item.owner?.name ?? '—'} />
              <InfoRow label="审核人" value={item.reviewer?.name ?? '阶段负责人（默认）'} />
              <InfoRow label="外部提供方" value={item.externalOrg?.name ?? '—'} />
              <InfoRow label="用途" value={item.purpose ?? '—'} />
              <InfoRow label="关联阶段" value={item.phaseCode ?? '—'} />
              <InfoRow label="截止日期" value={item.dueDate ? item.dueDate.slice(0, 10) : '—'} />
              <InfoRow label="必需" value={item.required ? '是（归档拦截）' : '否'} />
              {item.remark && <InfoRow label="备注" value={item.remark} />}
            </div>
          </section>

          {/* 上传 */}
          <section className="mb-4">
            <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {files.length > 0 ? (
                  <span>已上传 {files.length} 个版本，最新 v{files[0]?.version ?? '-'}</span>
                ) : (
                  <span>尚未上传文件</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {/* AI 解读（S4）：POST /api/ai/explain-file，条目可见性后端跟随 */}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiBusy}
                  onClick={runExplain}
                >
                  {aiBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" />}
                  {aiBusy ? 'AI 解读中…' : 'AI 解读'}
                </Button>
                <FileUploadButton requirementId={item.id} canUpload={canUpload} onUploaded={handleUploaded} />
                {canDeleteRequirement && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                    disabled={requirementDeleting}
                    onClick={handleDeleteRequirement}
                    title="删除该条目（仅未提交状态可删）"
                  >
                    {requirementDeleting ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                    )}
                    删除条目
                  </Button>
                )}
              </div>
            </div>
          </section>

          {/* 版本时间线（预览/下载） */}
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              版本时间线（{files.length}）
            </h3>
            {files.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                {canUpload ? '尚未上传任何版本，点击上方「上传新版本」提交文件' : '尚未上传任何版本'}
              </div>
            ) : (
              <VersionTimeline
                files={files}
                canDownload={canDownload}
                canPreview={item.permissions.view === true}
                canDelete={canDeleteFile}
                busyId={busyId}
                onDownload={handleDownload}
                onPreview={(f) => setPreviewFile(f)}
                onDelete={handleDeleteFile}
              />
            )}
          </section>

          {/* 审核操作（权限驱动） */}
          {canApprove && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">审核</h3>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 border-emerald-300 text-emerald-700"
                  onClick={() => doReview('approve')}
                  disabled={reviewBusy}
                >
                  <ShieldCheck className="mr-1 h-4 w-4" />
                  通过
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 border-red-300 text-red-600"
                  onClick={() => doReview('reject')}
                  disabled={reviewBusy}
                >
                  驳回
                </Button>
              </div>
            </section>
          )}

          <FilePreviewDialog
            file={previewFile}
            open={previewFile !== null}
            onClose={() => setPreviewFile(null)}
          />

          {/* AI 解读结果弹窗（S4） */}
          <Dialog open={aiExplanation !== null} onOpenChange={(v) => !v && setAiExplanation(null)}>
            <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-primary" /> AI 解读：{item.name}
                </DialogTitle>
                <DialogDescription>用途 / 要点 / 风险 / 建议下一步</DialogDescription>
              </DialogHeader>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{aiExplanation}</p>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
