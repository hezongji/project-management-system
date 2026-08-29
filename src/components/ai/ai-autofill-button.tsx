'use client'

/**
 * AI 自动填充按钮（2026-08-22 AI 智能助手 §六 表单入口，评审遗留缺口补齐）
 *
 * 用法：在表单区放置本组件，用户输入自然语言描述 → POST /api/ai/autofill
 * → 预览各字段建议值 → 「应用到表单」回填（仅覆盖非空建议，用户可继续编辑）。
 * 鉴权与数据边界由后端处理；本组件不直接查任何业务数据。
 */

import * as React from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ApiService } from '@/services/api'

interface Props {
  /** 表单用途描述（原样传给后端 context） */
  context: string
  /** 目标字段 key 列表（与 onApply 收到的 suggestions 键对齐） */
  fields: string[]
  /** 字段中文名（预览展示用） */
  labels?: Record<string, string>
  onApply: (suggestions: Record<string, string>) => void
  /** 按钮文案 */
  label?: string
}

export function AiAutofillButton({ context, fields, labels = {}, onApply, label = 'AI 自动填充' }: Props) {
  const [open, setOpen] = React.useState(false)
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<Record<string, string> | null>(null)

  const reset = () => {
    setInput('')
    setError(null)
    setResult(null)
    setLoading(false)
  }

  const generate = async () => {
    const text = input.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await ApiService.post<{ suggestions: Record<string, string> }>(
        '/ai/autofill',
        { context, fields, input: text },
        { timeout: 120_000 },
      )
      const s = res.data?.suggestions
      if (!s) throw new Error(res.message || 'AI 未返回建议，请稍后重试')
      setResult(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 服务暂不可用，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  const apply = () => {
    if (!result) return
    onApply(result)
    setOpen(false)
    reset()
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) reset()
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              AI 自动填充
            </DialogTitle>
            <DialogDescription>用一句话描述，AI 生成表单建议值，回填后可继续修改</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：上海某食品厂二期设备改造，涉及机械安装和电气调试"
              disabled={loading || !!result}
              maxLength={4000}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            {result && (
              <div className="space-y-1.5 rounded-md border bg-muted/40 p-2.5">
                {fields.map((f) => (
                  <div key={f} className="text-xs">
                    <span className="text-muted-foreground">{labels[f] ?? f}：</span>
                    <span className="whitespace-pre-wrap">{result[f]?.trim() || '（留空）'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            {result ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setResult(null)
                    setError(null)
                  }}
                >
                  重新生成
                </Button>
                <Button type="button" size="sm" onClick={apply}>
                  应用到表单
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" disabled={loading || !input.trim()} onClick={generate}>
                {loading ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    AI 生成中…
                  </>
                ) : (
                  '生成建议'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
