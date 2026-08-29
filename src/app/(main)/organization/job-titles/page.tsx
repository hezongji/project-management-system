'use client'

/**
 * /organization/job-titles 岗位字典 —— 依据《开发文档-项目管理系统重构》§7.2、§10.1
 *
 * 13 个标准岗位（流程模板阶段 ownerJobTitle 绑定引用）；
 * ADMIN 增删改；改名同步刷新人员/模板阶段冗余；被引用岗位不可删。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import { Briefcase, Info, Loader2, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DataTable } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { OrgService, JobTitleItem } from '@/services/org'
import { ApiError } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { globalConfirm } from '@/lib/global-confirm'

interface TitleForm {
  id?: string
  name: string
  deptHint: string
  sort: string
}

const EMPTY: TitleForm = { name: '', deptHint: '', sort: '0' }

export default function JobTitlesPage() {
  // 仅 ADMIN 可见（权限 V2 2026-08-21：组织架构整体并入管理模块）
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data: items, isLoading } = useQuery({
    queryKey: ['job-titles'],
    queryFn: OrgService.getJobTitles,
  })

  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState<TitleForm>(EMPTY)
  const [saving, setSaving] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      toast({ title: '请填写岗位名称', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        deptHint: form.deptHint.trim() || null,
        sort: parseInt(form.sort, 10) || 0,
      }
      if (form.id) await OrgService.updateJobTitle(form.id, payload)
      else await OrgService.createJobTitle(payload)
      toast({ description: form.id ? '岗位已更新' : '岗位已创建' })
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['job-titles'] })
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t: JobTitleItem) {
    if (!(await globalConfirm(
        `确认删除岗位「${t.name}」？\n${
          t.userCount > 0 || t.stageCount > 0
            ? `当前被 ${t.userCount} 名人员、${t.stageCount} 个模板阶段引用，将无法删除。`
            : '该岗位当前无引用。'
        }`
      ))) return
    try {
      await OrgService.deleteJobTitle(t.id)
      toast({ description: '岗位已删除' })
      queryClient.invalidateQueries({ queryKey: ['job-titles'] })
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  const columns = React.useMemo<ColumnDef<JobTitleItem, unknown>[]>(
    () => [
      {
        accessorKey: 'sort',
        header: '排序',
        cell: ({ row }) => <span className="w-8 text-muted-foreground">{row.original.sort}</span>,
      },
      {
        accessorKey: 'name',
        header: '岗位名称',
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'deptHint',
        header: '建议归属部门',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.deptHint ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'userCount',
        header: '在职人数',
        cell: ({ row }) =>
          row.original.userCount > 0 ? (
            <Badge variant="secondary">{row.original.userCount} 人</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              在册无人
            </Badge>
          ),
      },
      {
        accessorKey: 'stageCount',
        header: '模板阶段引用',
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.stageCount > 0 ? `${row.original.stageCount} 个阶段` : '—'}
          </span>
        ),
      },
      ...(isAdmin
        ? [
            {
              id: 'actions',
              header: '操作',
              cell: ({ row }: { row: { original: JobTitleItem } }) => (
                <div className="flex items-center gap-1">
                  <button
                    className="rounded p-1 hover:bg-black/5"
                    title="编辑"
                    onClick={() => {
                      setForm({
                        id: row.original.id,
                        name: row.original.name,
                        deptHint: row.original.deptHint ?? '',
                        sort: String(row.original.sort),
                      })
                      setOpen(true)
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-black/5"
                    title="删除"
                    onClick={() => handleDelete(row.original)}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </button>
                </div>
              ),
            } as ColumnDef<JobTitleItem, unknown>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin]
  )
  if (!isAdmin) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">无权限访问</h1>
          <p className="text-sm text-muted-foreground">
            岗位字典仅管理员（ADMIN）可见。如需访问，请联系管理员为你提升角色。
          </p>
        </CardContent>
      </Card>
    )
  }


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Briefcase className="h-6 w-6" /> 岗位字典
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            标准交付流程 20 阶段按岗位绑定负责人（§7.2 / §10.1），共 {items?.length ?? 0} 个岗位
          </p>
        </div>
        {isAdmin && (
          <Button
            size="sm"
            onClick={() => {
              setForm({ ...EMPTY, sort: String(items?.length ?? 0) })
              setOpen(true)
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> 新增岗位
          </Button>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          岗位改名会自动同步人员的岗位冗余与流程模板阶段的负责岗位；被人员或模板阶段引用的岗位不可删除。
          现场工程师 / 调试工程师 / 售后工程师 / 物流专员在册无人，项目实例化时匹配不到人将走待分配提醒（§10.3）。
        </p>
      </div>

      <DataTable columns={columns} data={items ?? []} loading={isLoading} empty="暂无岗位" />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑岗位' : '新增岗位'}</DialogTitle>
            <DialogDescription>岗位名称全局唯一。</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="jt-name">岗位名称 *</Label>
              <Input
                id="jt-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：电气工程师"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jt-hint">建议归属部门</Label>
              <Input
                id="jt-hint"
                value={form.deptHint}
                onChange={(e) => setForm({ ...form, deptHint: e.target.value })}
                placeholder="如：电气设计部"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jt-sort">排序号（小在前）</Label>
              <Input
                id="jt-sort"
                type="number"
                min={0}
                value={form.sort}
                onChange={(e) => setForm({ ...form, sort: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
