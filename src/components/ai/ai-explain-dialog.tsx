'use client'

/**
 * 文件条目「AI 解读」弹窗（AI 智能助手 §六）
 *
 * POST /api/ai/explain-file { fileRequirementId } →
 * { requirement:{name,code,status,project,latestFileVersion}, explanation }
 * 后端已做可见性校验（visibleRequirementFilter），不可见即 404。
 */

import * as React from 'react'
import { FileText, Loader2, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ApiService } from '@/services/api'

interface ExplainResult {
  requirement: {
    id: string
    name: string
    code: string
    status: string
    project: string | null
    latestFileVersion: number | null
  }
  explanation: string
}

export function AiExplainDialog({
  requirementId,
  requirementName,
  open,
  onOpenChange,
}: {
  requirementId: string | null
  requirementName?: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ExplainResult | null>(null)

  // 打开且有 id 时拉取（hooks 均在条件块之外）
  React.useEffect(() => {
    if (!open || !requirementId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    ApiService.post<ExplainResult>('/ai/explain-file', { fileRequirementId: requirementId }, { timeout: 120_000 })
      .then((res) => {
        if (cancelled) return
        if (res.data?.explanation) setResult(res.data)
        else setError(res.message || 'AI 未返回内容，请稍后重试')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '请求失败，请稍后重试')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, requirementId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI 解读
          </DialogTitle>
          <DialogDescription className="truncate">
            {result?.requirement?.name ?? requirementName ?? ''}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在分析文件条目…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && !loading && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              <span className="font-mono">{result.requirement.code}</span>
              <Badge variant="secondary">{result.requirement.status}</Badge>
              {result.requirement.project && <span>{result.requirement.project}</span>}
              {result.requirement.latestFileVersion != null && (
                <span>V{result.requirement.latestFileVersion}</span>
              )}
            </div>
            <div className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-3 text-sm leading-relaxed">
              {result.explanation}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
