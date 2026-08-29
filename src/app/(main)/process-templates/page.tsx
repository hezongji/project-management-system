'use client'

import { PageGuard } from '@/components/layout/page-guard'
/**
 * /process-templates 流程模板管理页 —— 依据《开发文档-项目管理系统重构》§7.3、§8.2⑦、§10.2
 *
 * - 列表表格（DataTable）：模板名称 / 阶段数 / 被引用项目数 / 是否默认（徽章）/ 操作
 * - 操作：编辑 | 设为默认 | 另存为副本 | 删除（编辑/新建/删除/设默认仅 ADMIN，requireRole 服务端兜底）
 * - 默认模板（标准交付流程20步）：只读保护，仅可调整各阶段负责岗位（PATCH stages[].ownerJobTitle）；
 *   删除按钮禁用（「唯一默认模板不可删」）
 * - 删除：非默认且未被项目引用可删（_count.projects>0 禁用，服务端 400 兜底）
 * - 编辑器：阶段表格化增删改插（修改/删除/任意位置插入/上下移序/末尾新增，order 自动重排）+
 *   交付物增删改（名称/必填/用途/范围）→ 保存 PATCH/POST
 * - 新建模板：从零逐条添加；行内「另存为副本」复制现有模板改
 * 非 ADMIN 只读浏览（无操作列）。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Copy,
  Loader2,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react'

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
import { useAuthStore } from '@/store/auth'
import { OrgService } from '@/services/org'
import { ApiError } from '@/services/api'
import {
  ProcessTemplateService,
  type ProcessTemplateDTO,
  type EditableStage,
  toEditableStages,
  toApiStages,
} from '@/services/template'
import { StageEditor } from '@/components/templates/stage-editor'

/** 编辑器弹窗模式 */
type EditorMode =
  | { kind: 'create'; base: ProcessTemplateDTO | null } // 新建（base=复制底稿）
  | { kind: 'edit'; template: ProcessTemplateDTO } // 自定义模板编辑
  | { kind: 'jobTitles'; template: ProcessTemplateDTO } // 默认模板岗位调整

function ProcessTemplatesPageInner() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const { data: templates, isLoading } = useQuery({
    queryKey: ['process-templates'],
    queryFn: ProcessTemplateService.list,
  })
  const { data: jobTitles } = useQuery({
    queryKey: ['job-titles'],
    queryFn: OrgService.getJobTitles,
  })
  const jobTitleNames = (jobTitles ?? []).map((t) => t.name)

  const [editor, setEditor] = React.useState<EditorMode | null>(null)
  const [stages, setStages] = React.useState<EditableStage[]>([])
  const [name, setName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState<ProcessTemplateDTO | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [confirmDefault, setConfirmDefault] = React.useState<ProcessTemplateDTO | null>(null)
  const [settingDefault, setSettingDefault] = React.useState(false)

  function openEditor(mode: EditorMode) {
    if (mode.kind === 'create') {
      setStages(mode.base ? toEditableStages(mode.base) : [])
      setName(mode.base ? `${mode.base.name}（副本）` : '')
    } else {
      setStages(toEditableStages(mode.template))
      setName(mode.template.name)
    }
    setEditor(mode)
  }

  function validate(): string | null {
    if (!name.trim()) return '请填写模板名称'
    if (stages.length === 0) return '模板至少需要一个阶段'
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i]
      if (!s.name.trim()) return `第 ${i + 1} 个阶段名称不能为空`
      const emptyDeliverable = (s.deliverables ?? []).findIndex((d) => !d.name.trim())
      if (emptyDeliverable >= 0) return `第 ${i + 1} 个阶段的第 ${emptyDeliverable + 1} 个交付物名称不能为空`
    }
    const dup = new Set<string>()
    for (const s of stages) {
      const key = s.name.trim()
      if (dup.has(key)) return `阶段名称重复：「${key}」`
      dup.add(key)
    }
    return null
  }

  async function handleSave() {
    if (!editor) return
    const err = validate()
    if (err) {
      toast({ title: err, variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      if (editor.kind === 'create') {
        const t = await ProcessTemplateService.create({
          name: name.trim(),
          stages: toApiStages(stages),
        })
        toast({ description: `模板「${t.name}」已创建（${t.stages.length} 个阶段）` })
      } else if (editor.kind === 'edit') {
        await ProcessTemplateService.update(editor.template.id, {
          name: name.trim(),
          stages: toApiStages(stages),
        })
        toast({ description: '模板已保存' })
      } else {
        // 默认模板：仅岗位调整
        await ProcessTemplateService.patchDefaultJobTitles(
          editor.template.id,
          stages.map((s, i) => ({
            id: editor.template.stages[i]?.id ?? '',
            ownerJobTitle: s.ownerJobTitle,
          })),
        )
        toast({ description: '默认模板各阶段负责岗位已更新' })
      }
      setEditor(null)
      queryClient.invalidateQueries({ queryKey: ['process-templates'] })
    } catch (e) {
      toast({
        title: '保存失败',
        description: e instanceof ApiError ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await ProcessTemplateService.remove(confirmDelete.id)
      toast({ description: `模板「${confirmDelete.name}」已删除` })
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['process-templates'] })
    } catch (e) {
      toast({
        title: '删除失败',
        description: e instanceof ApiError ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  async function handleSetDefault() {
    if (!confirmDefault) return
    setSettingDefault(true)
    try {
      await ProcessTemplateService.update(confirmDefault.id, { isDefault: true })
      toast({ description: `「${confirmDefault.name}」已设为默认模板` })
      setConfirmDefault(null)
      queryClient.invalidateQueries({ queryKey: ['process-templates'] })
    } catch (e) {
      toast({
        title: '设置失败',
        description: e instanceof ApiError ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSettingDefault(false)
    }
  }

  // ───────────────────────────── 表格列 ─────────────────────────────

  const columns = React.useMemo(() => {
    const cols: ColumnDef<ProcessTemplateDTO, unknown>[] = [
      {
        accessorKey: 'name',
        header: '模板名称',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{row.original.name}</span>
            {row.original.isDefault ? (
              <Badge className="shrink-0">
                <ShieldCheck className="mr-1 h-3 w-3" /> 默认
              </Badge>
            ) : null}
          </div>
        ),
        meta: { className: 'min-w-[180px]' },
      },
      {
        id: 'stageCount',
        accessorFn: (t) => t.stages.length,
        header: '阶段数',
        cell: ({ getValue }) => (
          <Badge variant="outline" className="font-normal">
            {getValue<number>()} 阶段
          </Badge>
        ),
      },
      {
        id: 'projectCount',
        accessorFn: (t) => t._count?.projects ?? 0,
        header: '被引用项目数',
        cell: ({ getValue }) => {
          const n = getValue<number>()
          return <span className={n > 0 ? 'text-foreground' : 'text-muted-foreground'}>{n}</span>
        },
      },
    ]
    if (isAdmin) {
      cols.push(
        {
          id: 'isDefault',
          accessorFn: (t) => (t.isDefault ? 1 : 0),
          header: '是否默认',
          cell: ({ row }) =>
            row.original.isDefault ? (
              <Badge>默认</Badge>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
        {
          id: 'actions',
          header: '操作',
          enableSorting: false,
          cell: ({ row }) => {
            const t = row.original
            const referenced = (t._count?.projects ?? 0) > 0
            const deleteDisabled = t.isDefault || referenced
            const deleteTitle = t.isDefault
              ? '唯一默认模板不可删除'
              : referenced
                ? `已被 ${t._count?.projects ?? 0} 个项目引用，不可删除`
                : '删除模板'
            return (
              <div className="flex flex-wrap items-center gap-1">
                {t.isDefault ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditor({ kind: 'jobTitles', template: t })}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> 调整岗位
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditor({ kind: 'edit', template: t })}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> 编辑
                  </Button>
                )}
                {!t.isDefault ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDefault(t)}
                    title="设为默认模板（新建项目未指定模板时的兜底流程）"
                  >
                    <Star className="mr-1 h-3.5 w-3.5" /> 设为默认
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEditor({ kind: 'create', base: t })}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> 另存为副本
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => setConfirmDelete(t)}
                  disabled={deleteDisabled}
                  title={deleteTitle}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除
                </Button>
              </div>
            )
          },
          meta: { className: 'min-w-[300px]' },
        },
      )
    }
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  return (
    <div className="space-y-6">
      {/* 头部（统一标题区） */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">流程模板</h1>
          <p className="text-sm text-muted-foreground">
            标准交付流程与自定义流程的定义与维护；阶段负责岗位用于新建项目时自动匹配负责人
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={() => openEditor({ kind: 'create', base: null })}>
            <Plus className="mr-1 h-4 w-4" /> 新建模板
          </Button>
        ) : null}
      </div>

      {/* 模板表格 */}
      <DataTable
        columns={columns}
        data={templates ?? []}
        loading={isLoading}
        empty="暂无流程模板"
        onRowClick={
          isAdmin
            ? (t) =>
                openEditor(
                  t.isDefault
                    ? { kind: 'jobTitles', template: t }
                    : { kind: 'edit', template: t },
                )
            : undefined
        }
      />

      {/* 编辑器弹窗（新建 / 自定义模板编辑 / 默认模板岗位调整 共用壳） */}
      <Dialog open={editor !== null} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === 'create'
                ? '新建流程模板'
                : editor?.kind === 'edit'
                  ? `编辑模板「${editor.template.name}」`
                  : `调整默认模板「${editor?.template.name ?? ''}」各阶段负责岗位`}
            </DialogTitle>
            <DialogDescription>
              {editor?.kind === 'jobTitles'
                ? '默认模板为系统标准流程（只读）；此处仅可调整各阶段的负责岗位，岗位用于新建项目时自动匹配阶段负责人。'
                : '每行一个阶段：可修改名称/负责岗位，↑↓ 调整顺序（或拖拽），＋ 在该行后插入新阶段，垃圾桶删除；点击「交付物」展开编辑交付物清单（名称/必填/用途/范围）。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tpl-name">模板名称</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={editor?.kind === 'jobTitles'}
                placeholder="如：外贸项目标准流程"
              />
            </div>
            <div className="space-y-2">
              <Label>阶段（{stages.length}）</Label>
              <StageEditor
                stages={stages}
                onStagesChange={setStages}
                jobTitles={jobTitleNames}
                readOnly={editor?.kind === 'jobTitles'}
                jobTitleSelectEnabled={editor?.kind !== undefined}
                deliverablesEditable={editor?.kind === 'create' || editor?.kind === 'edit'}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {editor?.kind === 'jobTitles' ? '保存岗位调整' : '保存模板'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 设为默认确认 */}
      <Dialog open={confirmDefault !== null} onOpenChange={(o) => !o && setConfirmDefault(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设为默认模板</DialogTitle>
            <DialogDescription>
              将「{confirmDefault?.name}」设为默认模板后，原默认模板自动取消默认；
              新建项目未显式选择流程时将使用该模板实例化阶段。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDefault(null)} disabled={settingDefault}>
              取消
            </Button>
            <Button onClick={handleSetDefault} disabled={settingDefault}>
              {settingDefault ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Star className="mr-1 h-4 w-4" />
              )}
              确认设为默认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认删除模板</DialogTitle>
            <DialogDescription>
              将删除模板「{confirmDelete?.name}」及其 {confirmDelete?.stages.length ?? 0} 个阶段定义。
              已按该模板创建的项目不受影响（阶段已实例化快照）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


export default function ProcessTemplatesPage() {
  return (
    <PageGuard pageKey="process-templates">
      <ProcessTemplatesPageInner />
    </PageGuard>
  )
}
