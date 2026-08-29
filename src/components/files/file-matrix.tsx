'use client'

/**
 * FileMatrix —— 文件矩阵（归档核对表）组件，依据《开发文档-项目管理系统重构》§7.7 / §8.2④
 *
 * 构成：
 *   - 归档按钮（POST /projects/:id/archive）：拦截时（400）弹出缺项清单（§7.4/§7.7）
 *   - 汇总统计卡（总条目/必需/已通过/待处理）
 *   - 条目×状态矩阵（按 phaseCode+catalogId 分组，六态计数）
 *   - 总表（每行一条目：名称/编号/阶段/目录/责任人/状态/版本数）
 *   - 缺项清单（必需 && status ∉ APPROVED/NA）
 *
 * 供 file-matrix-dialog.tsx（弹窗壳）与独立页复用。
 */

import { useCallback, useEffect, useState } from 'react'
import { Archive, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ApiError } from '@/services/api'
import { FilesService } from '@/services/files'
import { STATUS_BADGE } from './badges'
import type { ArchiveBlocker, FileMatrixData, FileStatus } from '@/types/files'

const MATRIX_STATUSES: FileStatus[] = ['WAITING', 'SUBMITTED', 'REVIEWING', 'APPROVED', 'REJECTED', 'NA']

export function FileMatrix({
  projectId,
  onArchived,
}: {
  projectId: string
  onArchived?: () => void
}) {
  const { toast } = useToast()
  const [data, setData] = useState<FileMatrixData | null>(null)
  const [loading, setLoading] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [blockers, setBlockers] = useState<ArchiveBlocker[] | null>(null)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      setData(await FilesService.getFileMatrix(projectId))
    } catch (err) {
      toast({
        title: '加载文件矩阵失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [projectId, toast])

  useEffect(() => {
    load()
  }, [load])

  async function handleArchive() {
    setArchiving(true)
    try {
      await FilesService.archiveProject(projectId)
      toast({ description: '项目已归档' })
      onArchived?.()
      await load()
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        // §7.4 归档拦截：errors[] = { name, status, owner }
        const list = Array.isArray(err.errors)
          ? (err.errors as ArchiveBlocker[]).filter((b) => b && typeof b.name === 'string')
          : []
        setBlockers(list.length > 0 ? list : null)
        if (list.length === 0) {
          toast({
            title: '无法归档',
            description: err.message,
            variant: 'destructive',
          })
        }
      } else {
        toast({
          title: '归档失败',
          description: err instanceof ApiError ? err.message : '请稍后重试',
          variant: 'destructive',
        })
      }
    } finally {
      setArchiving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中…
      </div>
    )
  }
  if (!data) return <div className="h-24 text-center text-sm text-muted-foreground">暂无数据</div>

  const s = data.summary
  const pending = s.waiting + s.submitted + s.reviewing + s.rejected

  return (
    <div className="space-y-4">
      {/* 汇总统计 */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <StatCard label="总条目" value={s.total} />
        <StatCard label="必需" value={s.required} />
        <StatCard label="已通过" value={s.approved} cls="text-emerald-600" />
        <StatCard label="待处理" value={pending} cls={pending > 0 ? 'text-amber-600' : 'text-emerald-600'} />
      </div>

      {/* 条目×状态矩阵（按阶段/目录分组） */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">状态矩阵（按阶段/目录分组）</h3>
        <div className="max-h-48 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60">
              <tr>
                <th className="px-3 py-2 text-left font-medium">阶段</th>
                <th className="px-3 py-2 text-left font-medium">目录</th>
                {MATRIX_STATUSES.map((st) => (
                  <th key={st} className="px-2 py-2 text-center font-medium">
                    {STATUS_BADGE[st].label}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-medium">合计</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.length === 0 ? (
                <tr>
                  <td colSpan={2 + MATRIX_STATUSES.length + 1} className="px-3 py-4 text-center text-muted-foreground">
                    暂无文件条目
                  </td>
                </tr>
              ) : (
                data.groups.map((g) => (
                  <tr key={`${g.phaseCode ?? '∅'}:${g.catalogId}`} className="border-t">
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {g.phaseName ? (
                        <span className="font-medium">{g.phaseName}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {g.phaseCode && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{g.phaseCode}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{g.catalogName}</td>
                    {MATRIX_STATUSES.map((st) => (
                      <td key={st} className="px-2 py-1.5 text-center tabular-nums">
                        {g.counts[st.toLowerCase() as keyof typeof g.counts] || 0}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-center font-medium tabular-nums">{g.total}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 总表：每行一条目 */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">文件条目总表（{data.rows.length}）</h3>
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60">
              <tr>
                <th className="px-3 py-2 text-left font-medium">名称</th>
                <th className="px-3 py-2 text-left font-medium">编号</th>
                <th className="px-3 py-2 text-left font-medium">阶段</th>
                <th className="px-3 py-2 text-left font-medium">目录</th>
                <th className="px-3 py-2 text-left font-medium">责任人</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-center font-medium">版本数</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const b = STATUS_BADGE[r.status]
                return (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{r.name}</span>
                      {r.required && <span className="ml-1 text-[10px] text-red-500">必需</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.code ?? '—'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-xs">
                      {r.phaseName ? r.phaseName : '—'}
                      {r.phaseCode && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{r.phaseCode}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{r.catalogName}</td>
                    <td className="px-3 py-1.5">{r.owner?.name ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
                    </td>
                    <td className="px-3 py-1.5 text-center tabular-nums">{r.versionCount}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 缺项清单 */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">缺项清单（{data.missing.length}）</h3>
        {data.missing.length === 0 ? (
          <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            所有必需条目均已通过（或标记不适用），可以归档。
          </p>
        ) : (
          <div className="max-h-40 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/60">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">名称</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">责任人</th>
                </tr>
              </thead>
              <tbody>
                {data.missing.map((m) => {
                  const b = STATUS_BADGE[m.status]
                  return (
                    <tr key={m.id} className="border-t">
                      <td className="px-3 py-1.5 font-medium">{m.name}</td>
                      <td className="px-3 py-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
                      </td>
                      <td className="px-3 py-1.5">{m.owner?.name ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 归档按钮 */}
      <div className="flex justify-end">
        <Button onClick={handleArchive} disabled={archiving}>
          {archiving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Archive className="mr-2 h-4 w-4" />}
          归档项目
        </Button>
      </div>

      {/* 归档拦截弹窗（§7.4 400 缺项清单） */}
      <Dialog open={blockers !== null} onOpenChange={(open) => !open && setBlockers(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>存在未通过的必需文件，无法归档</DialogTitle>
            <DialogDescription>以下必需条目未通过（或未标记不适用），补齐后方可归档。</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/60">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">名称</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">责任人</th>
                </tr>
              </thead>
              <tbody>
                {(blockers ?? []).map((b, i) => {
                  const badge = STATUS_BADGE[b.status] ?? STATUS_BADGE.WAITING
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5 font-medium">{b.name}</td>
                      <td className="px-3 py-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="px-3 py-1.5">{b.owner ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setBlockers(null)}>
              知道了
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatCard({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className={`text-xl font-semibold ${cls ?? ''}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}
