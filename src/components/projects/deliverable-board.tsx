'use client'

/**
 * 交付物看板弹窗（2026-08-21 个人交付物）
 *
 * 管理员/PM 在项目详情查看每位成员的交付物提交情况：
 *   - 按成员分组：姓名/部门/角色/应提交数/已提交/待提交列表/逾期
 *   - 催办按钮：对未提交条目生成待办 + IM 通知
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Bell, CheckCircle2, Loader2, Users } from 'lucide-react'
import { ApiService } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

interface DeliverableBoardData {
  project: { id: string; code: string; name: string }
  members: Array<{
    userId: string
    name: string
    username: string
    department: string | null
    role: string
    total: number
    submitted: number
    overdueCount: number
    pending: Array<{
      id: string
      name: string
      code: string | null
      phaseCode: string | null
      dueDate: string | null
      status: string
      fileCount: number
      overdue: boolean
    }>
  }>
  stats: { totalReqs: number; submittedReqs: number }
}

export function DeliverableBoard({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { toast } = useToast()
  const [urging, setUrging] = React.useState(false)
  const [urgedIds, setUrgedIds] = React.useState<Set<string>>(new Set())

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['deliverable-board', projectId],
    queryFn: () =>
      ApiService.get<DeliverableBoardData>(`/projects/${projectId}/deliverables`).then(
        (r) => r.data,
      ),
    enabled: open,
  })

  const urge = async (requirementIds: string[]) => {
    setUrging(true)
    try {
      await ApiService.post(`/projects/${projectId}/deliverables`, { requirementIds })
      setUrgedIds((prev) => {
        const next = new Set(prev)
        for (const id of requirementIds) next.add(id)
        return next
      })
      toast({ description: `已催办 ${requirementIds.length} 个交付物` })
      refetch()
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '催办失败',
      })
    } finally {
      setUrging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> 交付物看板
            {data && (
              <Badge variant="secondary" className="font-normal">
                {data.stats.submittedReqs}/{data.stats.totalReqs} 已提交
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : data.members.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">暂无成员</p>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            {data.members.map((m) => (
              <div key={m.userId} className="rounded-lg border">
                {/* 成员头 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.department ?? '—'} · {m.username}
                    </span>
                    <Badge variant={m.role === 'OWNER' ? 'default' : 'secondary'}>
                      {m.role === 'OWNER' ? '负责人' : m.role === 'MANAGER' ? '项目管理' : '成员'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" /> {m.submitted}/{m.total} 已提交
                    </span>
                    {m.overdueCount > 0 && (
                      <span className="flex items-center gap-1 text-red-600">
                        <AlertTriangle className="h-3.5 w-3.5" /> {m.overdueCount} 逾期
                      </span>
                    )}
                    {m.total > 0 && (
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            m.submitted === m.total ? 'bg-emerald-500' : 'bg-primary',
                          )}
                          style={{ width: `${(m.submitted / m.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* 交付物行 */}
                {m.pending.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    {m.total === 0 ? '未分配交付物' : '全部已提交 ✓'}
                  </p>
                ) : (
                  <div className="divide-y">
                    {m.pending.map((r) => {
                      const urged = urgedIds.has(r.id)
                      return (
                        <div
                          key={r.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm">{r.name}</span>
                              {r.overdue && (
                                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                                  已逾期
                                </Badge>
                              )}
                              {r.fileCount > 0 && (
                                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                                  {r.fileCount} 个文件
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {r.code ?? ''} ·{' '}
                              {r.phaseCode ? `阶段 ${r.phaseCode}` : '个人交付物'}
                              {r.dueDate ? ` · 截止 ${r.dueDate.slice(0, 10)}` : ''}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant="outline">{r.status}</Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={urging || urged}
                              onClick={() => urge([r.id])}
                            >
                              <Bell className="mr-1 h-3 w-3" />
                              {urged ? '已催办' : '催办'}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}

            {/* 一键催办全部未提交 */}
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={urging || data.members.every((m) => m.pending.length === 0)}
                onClick={() => {
                  const allIds = data.members.flatMap((m) => m.pending.map((r) => r.id))
                  urge(allIds)
                }}
              >
                <Bell className="mr-1 h-3.5 w-3.5" /> 催办全部未提交
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
