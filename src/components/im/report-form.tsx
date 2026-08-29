'use client'

/**
 * ReportForm —— 工作汇报表单（依据《开发文档-项目管理系统重构》§8.2⑥ / §7.8）
 *
 * 独立可复用组件：类型（日报/周报切换）/ 所属项目（GET /api/projects 下拉）/
 * 日期 / 今日完成(done) / 明日计划(plan) / 需要支持(needHelp)。
 * 提交 → POST /api/reports → 成功 toast + 清空。
 *
 * 注意：本组件不依赖 messages/page.tsx，可独立引入到任意页面。
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/services/api-instance'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

interface ProjectOption {
  id: string
  name: string
  code: string
}

/** ISO 周数（周一为一周开始） */
function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/** 本周范围（周一 ~ 周日） */
function getWeekRange(d: Date): { mon: Date; sun: Date } {
  const day = d.getDay() || 7 // 周一=1 ... 周日=7
  const mon = new Date(d)
  mon.setDate(d.getDate() - day + 1)
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  return { mon, sun }
}

const fmt = (d: Date) =>
  `${d.getMonth() + 1}月${d.getDate()}日`

export interface ReportFormProps {
  className?: string
  /** 内嵌模式：不包裹 Card 外壳（挂载于 Dialog 时传入） */
  embedded?: boolean
  /** 提交成功回调（可选，用于 Dialog 关闭） */
  onSuccess?: () => void
}

export default function ReportForm({ className, embedded, onSuccess }: ReportFormProps) {
  const { toast } = useToast()

  const [kind, setKind] = useState<'daily' | 'weekly'>('daily')
  const [projectId, setProjectId] = useState('')
  const [date, setDate] = useState('')
  const [done, setDone] = useState('')
  const [plan, setPlan] = useState('')
  const [needHelp, setNeedHelp] = useState('')

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [submitting, setSubmitting] = useState(false)

  // 日期缺省：日报=今天；周报=本周一（2026-08-21 周报按周维度）
  useEffect(() => {
    if (!date) {
      if (kind === 'weekly') {
        const { mon } = getWeekRange(new Date())
        const m = String(mon.getMonth() + 1).padStart(2, '0')
        const day = String(mon.getDate()).padStart(2, '0')
        setDate(`${mon.getFullYear()}-${m}-${day}`)
      } else {
        const d = new Date()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        setDate(`${d.getFullYear()}-${m}-${day}`)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  // 拉取我可见的项目列表（GET /api/projects，取前 100 条）
  useEffect(() => {
    let cancelled = false
    api
      .get('/projects', { params: { page: 1, limit: 100 } })
      .then((res) => {
        if (cancelled) return
        const data = res.data?.data
        const items: ProjectOption[] = Array.isArray(data?.items)
          ? data.items.map((p: { id: string; name: string; code: string }) => ({
              id: p.id,
              name: p.name,
              code: p.code,
            }))
          : []
        setProjects(items)
        if (!projectId && items.length > 0) setProjectId(items[0].id)
      })
      .catch(() => {
        /* 项目列表加载失败不阻塞表单 */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!projectId) {
      toast({ title: '请选择所属项目', variant: 'destructive' })
      return
    }
    if (!done.trim() && !plan.trim()) {
      toast({ title: '请至少填写「今日完成」或「明日计划」', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const res = await api.post('/reports', {
        type: kind,
        projectId,
        date: date || undefined,
        done: done.trim(),
        plan: plan.trim(),
        needHelp: needHelp.trim(),
      })
      if (res.data?.success === false) {
        toast({ title: res.data?.message || '提交失败', variant: 'destructive' })
        return
      }
      toast({ description: '工作汇报已提交' })
      // 清空内容（保留类型/项目/日期，便于连续汇报）
      setDone('')
      setPlan('')
      setNeedHelp('')
      onSuccess?.()
    } catch (err) {
      const msg =
        (err as { message?: string })?.message || '提交失败，请稍后重试'
      toast({ title: msg, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }, [kind, projectId, date, done, plan, needHelp, toast])

  const formBody = (
    <>
      {/* 类型切换 + 周报提示（2026-08-21：周报显示年份与周数） */}
      <div className="space-y-2">
        <div className="inline-flex rounded-md border border-input p-1">
          {(['daily', 'weekly'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                'rounded px-4 py-1.5 text-sm transition-colors',
                kind === k
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {k === 'daily' ? '日报' : '周报'}
            </button>
          ))}
        </div>
        {kind === 'weekly' && (() => {
          const now = new Date()
          const { mon, sun } = getWeekRange(now)
          return (
            <div className="rounded-md bg-primary/5 px-3 py-2 text-sm">
              <span className="font-semibold text-primary">
                {now.getFullYear()} 年第 {getISOWeek(now)} 周
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {fmt(mon)} ~ {fmt(sun)}（本周）
              </span>
            </div>
          )
        })()}
      </div>

        {/* 所属项目 + 日期 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-project">所属项目</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="report-project">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-date">
              {kind === 'weekly' ? '日期（当周周一起）' : '日期'}
            </Label>
            <Input
              id="report-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        {/* 汇报内容（周报/日报标签切换，2026-08-21） */}
        <div className="space-y-1.5">
          <Label htmlFor="report-done">
            {kind === 'weekly' ? '本周完成' : '今日完成'}
          </Label>
          <Textarea
            id="report-done"
            rows={3}
            placeholder={
              kind === 'weekly'
                ? '例：1.完成接线 2.程序下载 3.调试通过'
                : '例：1.完成接线 2.程序下载'
            }
            value={done}
            onChange={(e) => setDone(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-plan">
            {kind === 'weekly' ? '下周计划' : '明日计划'}
          </Label>
          <Textarea
            id="report-plan"
            rows={3}
            placeholder={kind === 'weekly' ? '例：下周联动调试' : '例：明天联动调试'}
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-help">需要支持</Label>
          <Textarea
            id="report-help"
            rows={2}
            placeholder="例：需采购备件"
            value={needHelp}
            onChange={(e) => setNeedHelp(e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '提交中…' : '提交汇报'}
          </Button>
        </div>
    </>
  )

  if (embedded) {
    return <div className={cn('space-y-4', className)}>{formBody}</div>
  }

  return (
    <Card className={cn('w-full', className)}>
      <CardHeader>
        <CardTitle className="text-base">工作汇报</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{formBody}</CardContent>
    </Card>
  )
}
