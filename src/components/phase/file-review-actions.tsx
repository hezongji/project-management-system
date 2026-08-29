'use client'

/**
 * 文件条目审核操作区（§7.7 approve/reject/na/obsolete + §5 七态）
 *
 * 供条目详情抽屉嵌入（P2-1 抽屉交付后挂载），自包含：
 *   - approve / reject：审核人可见（permissions.approve），且状态为 SUBMITTED/REVIEWING 时可点；
 *     approve 意见可选，reject 意见必填
 *   - na（不适用）/ obsolete（作废）：项目 edit 可见（permissions.edit），原因必填
 *   - 操作后回调 onChanged 刷新抽屉/列表数据
 * 按钮显隐完全由外部传入的 permissions 驱动（§4.7 前端不自算权限），服务端 requireCan 终审。
 */

import { useState } from 'react'
import { CheckCircle2, XCircle, Ban, ArchiveX, Loader2 } from 'lucide-react'
import { api } from '@/services/api-instance'
import { useToast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { FileStatusBadge } from './file-status-badge'
import type { FileStatus } from '@/types/phase'

type Mode = 'approve' | 'reject' | 'na' | 'obsolete' | null

const MODE_HINT: Record<Exclude<Mode, null>, { label: string; placeholder: string; required: boolean }> = {
  approve: { label: '通过', placeholder: '审核意见（可选）', required: false },
  reject: { label: '驳回', placeholder: '驳回意见（必填）', required: true },
  na: { label: '不适用', placeholder: '不适用原因（必填）', required: true },
  obsolete: { label: '作废', placeholder: '作废原因（必填）', required: true },
}

export interface FileReviewActionsProps {
  requirementId: string
  status: FileStatus
  permissions?: { approve?: boolean; edit?: boolean }
  onChanged?: () => void
}

export function FileReviewActions({
  requirementId,
  status,
  permissions,
  onChanged,
}: FileReviewActionsProps) {
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const canApprove = permissions?.approve && (status === 'SUBMITTED' || status === 'REVIEWING')
  const canEdit = permissions?.edit

  if (!canApprove && !canEdit) return null

  async function submit(m: Exclude<Mode, null>) {
    const cfg = MODE_HINT[m]
    if (cfg.required && !text.trim()) {
      toast({ title: cfg.placeholder, variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const payload = m === 'approve' || m === 'reject' ? { comment: text.trim() } : { reason: text.trim() }
      const res = await api.post(`/file-requirements/${requirementId}/${m}`, payload)
      toast({ title: res.data?.message ?? '操作成功' })
      setMode(null)
      setText('')
      onChanged?.()
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '操作失败'
      toast({ title: '操作失败', description: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <FileStatusBadge status={status} />
        {canApprove && (
          <>
            <Button size="sm" variant="default" onClick={() => setMode('approve')} disabled={busy}>
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              通过
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setMode('reject')} disabled={busy}>
              <XCircle className="mr-1 h-3.5 w-3.5" />
              驳回
            </Button>
          </>
        )}
        {canEdit && (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode('na')} disabled={busy}>
              <Ban className="mr-1 h-3.5 w-3.5" />
              不适用
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('obsolete')} disabled={busy}>
              <ArchiveX className="mr-1 h-3.5 w-3.5" />
              作废
            </Button>
          </>
        )}
      </div>

      {mode && (
        <div className="rounded-md border p-2">
          <div className="mb-1.5 text-xs font-medium">{MODE_HINT[mode].label}确认</div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={MODE_HINT[mode].placeholder}
            rows={2}
            className="mb-2 text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setMode(null); setText('') }} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={() => submit(mode)} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              确认{MODE_HINT[mode].label}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
