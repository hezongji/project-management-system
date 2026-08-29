'use client'

/**
 * 费用分类管理（F3）—— 系统管理页「费用分类」Tab（仅 ADMIN，页面自身已做角色门禁）
 *
 * 预置分类（isSystem=true）：显示「预置」徽章，不可删除、不可改名称/编码（仅可调排序）
 * 自定义分类：可新增 / 编辑（名称、编码、排序）/ 删除（已被费用记录引用时后端 400 拒绝）
 * GET /api/expense-categories 仅返回启用中的分类（停用分类不展示，故不提供停用开关避免无法恢复）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, Plus, RefreshCw, Save, Tags, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import type { ExpenseCategory } from './expense-claim-form-dialog'

export function ExpenseCategoryManager() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data: categories = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () =>
      ApiService.get<ExpenseCategory[]>('/expense-categories').then((r) => r.data ?? []),
  })

  // ── 新增/编辑弹窗 ──
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ExpenseCategory | null>(null)
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const [sort, setSort] = React.useState('0')
  const [saving, setSaving] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setName('')
    setCode('')
    setSort('0')
    setDialogOpen(true)
  }
  const openEdit = (c: ExpenseCategory) => {
    setEditing(c)
    setName(c.name)
    setCode(c.code)
    setSort(String(c.sort))
    setDialogOpen(true)
  }

  const save = async () => {
    if (!name.trim()) {
      toast({ variant: 'destructive', description: '分类名称不能为空' })
      return
    }
    const sortNum = Number(sort)
    if (Number.isNaN(sortNum)) {
      toast({ variant: 'destructive', description: '排序必须为整数' })
      return
    }
    setSaving(true)
    try {
      if (editing) {
        // 系统预置分类：后端仅允许改 sort（name/code 会被 400 拒绝，这里不发送）
        await ApiService.patch(`/expense-categories/${editing.id}`, {
          ...(editing.isSystem ? {} : { name: name.trim(), code: code.trim() }),
          sort: Math.trunc(sortNum),
        })
        toast({ description: '分类已更新 ✓' })
      } else {
        await ApiService.post('/expense-categories', {
          name: name.trim(),
          ...(code.trim() ? { code: code.trim() } : {}),
          sort: Math.trunc(sortNum),
        })
        toast({ description: '分类已创建 ✓' })
      }
      queryClient.invalidateQueries({ queryKey: ['expense-categories'] })
      setDialogOpen(false)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  // ── 删除 ──
  const [deleting, setDeleting] = React.useState<ExpenseCategory | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)
  const doDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await ApiService.delete(`/expense-categories/${deleting.id}`)
      toast({ description: '分类已删除' })
      setDeleting(null)
      queryClient.invalidateQueries({ queryKey: ['expense-categories'] })
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '删除失败',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="space-y-3 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Tags className="h-4 w-4" /> 费用分类
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            预置分类不可删除；自定义分类可增删改（已被费用记录引用的分类无法删除）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            刷新
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            新增分类
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载分类…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">分类名称</th>
                <th className="px-3 py-2 font-medium">编码</th>
                <th className="px-3 py-2 font-medium">排序</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-medium">{c.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{c.code}</td>
                  <td className="px-3 py-2.5">{c.sort}</td>
                  <td className="px-3 py-2.5">
                    {c.isSystem ? (
                      <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100">
                        预置
                      </Badge>
                    ) : (
                      <Badge variant="outline">自定义</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openEdit(c)}
                        title={c.isSystem ? '预置分类仅可调整排序' : '编辑分类'}
                      >
                        <Pencil className="mr-0.5 h-3 w-3" />
                        编辑
                      </Button>
                      {!c.isSystem && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => setDeleting(c)}
                          title="删除分类"
                        >
                          <Trash2 className="mr-0.5 h-3 w-3" />
                          删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    暂无分类，点击右上角「新增分类」创建
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? (editing.isSystem ? '调整预置分类排序' : '编辑费用分类') : '新增费用分类'}</DialogTitle>
            <DialogDescription>
              {editing?.isSystem
                ? '系统预置分类的名称与编码不可修改，仅支持调整排序'
                : '分类编码留空时自动生成（CUSTOM-xxx）；仅允许字母/数字/下划线/中划线'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cat-name">
                分类名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cat-name"
                maxLength={50}
                placeholder="如：差旅费、招待费"
                value={name}
                disabled={editing?.isSystem === true}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="cat-code">分类编码</Label>
                <Input
                  id="cat-code"
                  maxLength={30}
                  placeholder="留空自动生成"
                  value={code}
                  disabled={editing?.isSystem === true}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cat-sort">排序</Label>
                <Input
                  id="cat-sort"
                  type="number"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`删除分类「${deleting?.name ?? ''}」`}
        description="仅未被任何费用记录引用的自定义分类可删除；该操作不可恢复。"
        confirmText="删除"
        destructive
        loading={deleteBusy}
        onConfirm={doDelete}
      />
    </div>
  )
}
