'use client'

/**
 * /organization 组织架构首页 —— 依据《开发文档-项目管理系统重构》§7.2、§8.1、§10.3
 *
 * 左：部门树（真实 9 顶级 + 子级，负责人/成员数）；右：选中部门成员卡。
 * ADMIN：部门 CRUD（Dialog）+ 人员 Excel 导入（users.xlsx 模板下载/dryRun 校验）。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Building2,
  Pencil,
  Plus,
  Trash2,
  UserRound,
  UserRoundPlus,
  Download,
  Upload,
  FileSpreadsheet,
  Loader2,
  Users,
  ListTree,
  Network,
  PowerOff,
  ShieldAlert,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ImportResultDialog } from '@/components/organization/import-result-dialog'
import { OrgChartView } from '@/components/organization/org-chart-view'
import { MemberFormDialog } from '@/components/organization/member-form-dialog'
import { OrgService, DeptMemberBrief, ImportResult } from '@/services/org'
import { AdminService } from '@/services/admin'
import { ApiError } from '@/services/api'
import { downloadUsersTemplate, exportUsers } from '@/lib/excel-templates'
import { useAuthStore } from '@/store/auth'
import type { DeptNode } from '@/lib/org-tree'
import { cn } from '@/lib/utils'
import { globalConfirm } from '@/lib/global-confirm'

// ───────────────────────────── 部门树节点 ─────────────────────────────

function DeptTreeItem({
  node,
  depth,
  selectedId,
  onSelect,
  isAdmin,
  onEdit,
  onDelete,
}: {
  node: DeptNode
  depth: number
  selectedId: string | null
  onSelect: (n: DeptNode) => void
  isAdmin: boolean
  onEdit: (n: DeptNode) => void
  onDelete: (n: DeptNode) => void
}) {
  const [open, setOpen] = React.useState(true)
  const selected = selectedId === node.id

  return (
    <div>
      <div
        className={cn(
          'group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60',
          selected && 'bg-primary/10 font-medium text-primary'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node)}
      >
        {node.children.length > 0 ? (
          <button
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-black/5"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
        {node.manager && (
          <span className="ml-1 hidden shrink-0 text-xs text-muted-foreground md:inline">
            · {node.manager.name}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground">
          {node.memberCount}
        </span>
        {isAdmin && (
          <span className="ml-0.5 hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              className="rounded p-0.5 hover:bg-black/10"
              title="编辑部门"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(node)
              }}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              className="rounded p-0.5 hover:bg-black/10"
              title="删除部门（需空部门）"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(node)
              }}
            >
              <Trash2 className="h-3 w-3 text-red-500" />
            </button>
          </span>
        )}
      </div>
      {open &&
        node.children.map((c) => (
          <DeptTreeItem
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
    </div>
  )
}

// ───────────────────────────── 成员卡 ─────────────────────────────

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理员',
  PROJECT_MANAGER: '项目管理员',
  MEMBER: '成员',
}

function MemberCard({
  m,
  isAdmin,
  onEdit,
  onDeactivate,
  onDelete,
}: {
  m: DeptMemberBrief
  isAdmin: boolean
  onEdit: (m: DeptMemberBrief) => void
  onDeactivate: (m: DeptMemberBrief) => void
  onDelete: (m: DeptMemberBrief) => void
}) {
  return (
    <Card className="group overflow-hidden">
      <CardContent className="flex gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {m.name.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{m.name}</span>
            {m.jobTitle ? (
              <Badge variant="secondary">{m.jobTitle}</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                未设岗位
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {m.duties || '—'}
          </p>
          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
            {m.phone && <span>{m.phone}</span>}
            <span>{ROLE_LABEL[m.role] ?? m.role}</span>
            <span className="hidden truncate xl:inline">{m.email}</span>
          </div>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 flex-col items-center gap-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
            <button
              className="rounded p-1 hover:bg-black/10"
              title="编辑成员"
              onClick={() => onEdit(m)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded p-1 hover:bg-black/10"
              title="停用成员"
              onClick={() => onDeactivate(m)}
            >
              <PowerOff className="h-3.5 w-3.5 text-amber-500" />
            </button>
            <button
              className="rounded p-1 hover:bg-black/10"
              title="删除成员（有业务引用时不可删）"
              onClick={() => onDelete(m)}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ───────────────────────────── 页面 ─────────────────────────────

interface DeptForm {
  id?: string
  name: string
  parentId: string
  managerId: string
  sort: string
}

const EMPTY_FORM: DeptForm = { name: '', parentId: '', managerId: '', sort: '0' }

export default function OrganizationPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'
  if (!isAdmin) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">无权限访问</h1>
          <p className="text-sm text-muted-foreground">
            组织架构仅管理员（ADMIN）可见。如需访问，请联系管理员为你提升角色。
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Tabs defaultValue="list">
      <TabsList>
        <TabsTrigger value="list">
          <ListTree className="mr-1.5 h-4 w-4" /> 部门列表
        </TabsTrigger>
        <TabsTrigger value="chart">
          <Network className="mr-1.5 h-4 w-4" /> 架构图
        </TabsTrigger>
      </TabsList>
      <TabsContent value="list">
        <DeptListView />
      </TabsContent>
      <TabsContent value="chart">
        <OrgChartView />
      </TabsContent>
    </Tabs>
  )
}

// ───────────────────────────── 部门列表视图（原 /organization 主体）─────────────────────────────

function DeptListView() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'

  const { data: tree, isLoading } = useQuery({
    queryKey: ['departments'],
    queryFn: OrgService.getDepartments,
  })

  const [selected, setSelected] = React.useState<DeptNode | null>(null)
  const [includeChildren, setIncludeChildren] = React.useState(true)
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<DeptForm>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [importResult, setImportResult] = React.useState<ImportResult | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [dryRun, setDryRun] = React.useState(true)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // ───────────── 成员新增/编辑弹窗状态 ─────────────
  const [memberFormOpen, setMemberFormOpen] = React.useState(false)
  const [editingMember, setEditingMember] = React.useState<DeptMemberBrief | null>(null)

  React.useEffect(() => {
    if (tree && tree.length > 0 && !selected) setSelected(tree[0])
  }, [tree, selected])

  /** 全部成员扁平（负责人下拉用） */
  const allMembers = React.useMemo(() => {
    const out: DeptMemberBrief[] = []
    function walk(n: DeptNode) {
      out.push(...n.members)
      n.children.forEach(walk)
    }
    tree?.forEach(walk)
    return out
  }, [tree])

  /** 部门路径列表（上级部门下拉用）：id → 显示路径 */
  const deptOptions = React.useMemo(() => {
    const out: Array<{ id: string; path: string }> = []
    function walk(n: DeptNode, prefix: string) {
      const path = prefix ? `${prefix} / ${n.name}` : n.name
      out.push({ id: n.id, path })
      n.children.forEach((c) => walk(c, path))
    }
    tree?.forEach((n) => walk(n, ''))
    return out
  }, [tree])

  const totalUsers = React.useMemo(
    () => tree?.reduce((acc, n) => acc + n.memberCount, 0) ?? 0,
    [tree]
  )

  /** 成员 id → 直属部门 id（编辑弹窗回填部门用） */
  const memberDeptMap = React.useMemo(() => {
    const map = new Map<string, string>()
    function walk(n: DeptNode) {
      n.members.forEach((m) => map.set(m.id, n.id))
      n.children.forEach(walk)
    }
    tree?.forEach(walk)
    return map
  }, [tree])

  /** 选中部门成员（可选含子部门） */
  const shownMembers = React.useMemo(() => {
    if (!selected) return []
    if (!includeChildren) return selected.members
    const out: DeptMemberBrief[] = []
    function walk(n: DeptNode) {
      out.push(...n.members)
      n.children.forEach(walk)
    }
    walk(selected)
    return out
  }, [selected, includeChildren])

  const selectedPath = React.useMemo(() => {
    const sel = selected
    if (!sel || !tree) return ''
    const found: string[] = []
    function walk(n: DeptNode, prefix: string) {
      const path = prefix ? `${prefix} / ${n.name}` : n.name
      if (n.id === sel!.id) found.push(path)
      n.children.forEach((c) => walk(c, path))
    }
    tree.forEach((n) => walk(n, ''))
    return found[0] ?? ''
  }, [tree, selected])

  // ───────────── 表单 ─────────────

  function openCreate() {
    setForm({ ...EMPTY_FORM, parentId: selected?.id ?? '' })
    setFormOpen(true)
  }
  function openEdit(n: DeptNode) {
    setForm({
      id: n.id,
      name: n.name,
      parentId: n.parentId ?? '',
      managerId: n.managerId ?? '',
      sort: String(n.sort),
    })
    setFormOpen(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      toast({ title: '请填写部门名称', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        parentId: form.parentId || null,
        managerId: form.managerId || null,
        sort: parseInt(form.sort, 10) || 0,
      }
      if (form.id) {
        await OrgService.updateDepartment(form.id, payload)
        toast({ description: '部门已更新' })
      } else {
        await OrgService.createDepartment(payload)
        toast({ description: '部门已创建' })
      }
      setFormOpen(false)
      queryClient.invalidateQueries({ queryKey: ['departments'] })
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

  async function handleDelete(n: DeptNode) {
    if (!(await globalConfirm(`确认删除部门「${n.name}」？仅空部门（无成员、无子部门）可删除。`))) return
    try {
      await OrgService.deleteDepartment(n.id)
      toast({ description: '部门已删除' })
      queryClient.invalidateQueries({ queryKey: ['departments'] })
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  // ───────────── 成员新增/编辑/停用/删除 ─────────────

  function refreshOrg() {
    queryClient.invalidateQueries({ queryKey: ['departments'] })
    queryClient.invalidateQueries({ queryKey: ['org-chart'] })
  }

  function openCreateMember() {
    setEditingMember(null)
    setMemberFormOpen(true)
  }

  function openEditMember(m: DeptMemberBrief) {
    setEditingMember(m)
    setMemberFormOpen(true)
  }

  async function handleDeactivate(m: DeptMemberBrief) {
    if (!(await globalConfirm(`确认停用成员「${m.name}」？停用后无法登录，可随时重新启用。`))) return
    try {
      await AdminService.updateUser({ userId: m.id, isActive: false })
      toast({ description: `已停用「${m.name}」` })
      refreshOrg()
    } catch (err) {
      toast({
        title: '停用失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  async function handleDeleteMember(m: DeptMemberBrief) {
    if (!(await globalConfirm(
        `确认删除成员「${m.name}」？\n若存在项目/任务/文件等业务引用将无法删除（请改用停用）。此操作不可恢复。`
      ))) return
    try {
      await AdminService.deleteUser(m.id)
      toast({ description: `已删除「${m.name}」` })
      refreshOrg()
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  // ───────────── Excel 导入 ─────────────

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选同一文件
    if (!file) return
    setImporting(true)
    try {
      const result = await OrgService.importUsers(file, dryRun)
      setImportResult(result)
      queryClient.invalidateQueries({ queryKey: ['departments'] })
    } catch (err) {
      toast({
        title: '导入失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleExport() {
    if (!tree) return
    const rows: Array<{
      name: string
      email: string
      phone: string | null
      deptPath: string
      jobTitle: string | null
      duties: string | null
    }> = []
    function walk(n: DeptNode, prefix: string) {
      const path = prefix ? `${prefix}/${n.name}` : n.name
      for (const m of n.members) {
        rows.push({
          name: m.name,
          email: m.email,
          phone: m.phone,
          deptPath: path,
          jobTitle: m.jobTitle,
          duties: m.duties,
        })
      }
      n.children.forEach((c) => walk(c, path))
    }
    tree.forEach((n) => walk(n, ''))
    await exportUsers(rows)
    toast({ description: `已导出 ${rows.length} 人花名册` })
  }

  return (
    <div className="space-y-4">
      {/* 顶栏（统一标题区） */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Building2 className="h-6 w-6" /> 组织架构
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isLoading ? (
              <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                共 {tree?.length ?? 0} 个一级部门 · 在职 {totalUsers} 人
              </>
            )}
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              仅校验
            </label>
            <Button variant="outline" size="sm" onClick={() => downloadUsersTemplate()}>
              <FileSpreadsheet className="mr-1 h-4 w-4" /> 下载模板
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              {importing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
              导入人员
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-1 h-4 w-4" /> 导出花名册
            </Button>
            <Button variant="outline" size="sm" onClick={openCreateMember}>
              <UserRoundPlus className="mr-1 h-4 w-4" /> 新增成员
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" /> 新增部门
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleImportFile}
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* 左：部门树 */}
        <div className="rounded-lg border bg-card p-2">
          <div className="px-2 pb-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            部门树
          </div>
          {isLoading ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : (
            tree?.map((n) => (
              <DeptTreeItem
                key={n.id}
                node={n}
                depth={0}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                isAdmin={isAdmin}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>

        {/* 右：成员 */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-medium">{selected?.name ?? '未选择部门'}</h2>
              {selected && (
                <p className="text-sm text-muted-foreground">
                  {selectedPath}
                  {selected.manager && ` · 负责人：${selected.manager.name}`}
                </p>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={includeChildren}
                onChange={(e) => setIncludeChildren(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              含子部门
            </label>
          </div>

          {shownMembers.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground">
              <Users className="h-8 w-8 opacity-40" />
              <p className="text-sm">
                {selected?.id ? '该部门暂无在职成员' : '在左侧选择部门查看成员'}
              </p>
              {selected && !selected.manager && (
                <p className="text-xs opacity-70">
                  §10.3：{selected.name}
                  {selected.children.length > 0 ? '（含子级）' : ''}负责人待设置
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shownMembers.map((m) => (
                <MemberCard
                  key={m.id}
                  m={m}
                  isAdmin={isAdmin}
                  onEdit={openEditMember}
                  onDeactivate={handleDeactivate}
                  onDelete={handleDeleteMember}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 部门表单 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑部门' : '新增部门'}</DialogTitle>
            <DialogDescription>
              部门名称在同一层级下唯一；负责人从在职人员中选择。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">部门名称 *</Label>
              <Input
                id="dept-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：电气设计部"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>上级部门</Label>
              <Select
                value={form.parentId || 'none'}
                onValueChange={(v) => setForm({ ...form, parentId: v === 'none' ? '' : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="顶级部门" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">（顶级部门）</SelectItem>
                  {deptOptions
                    .filter((d) => d.id !== form.id)
                    .map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.path}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>部门负责人</Label>
              <Select
                value={form.managerId || 'none'}
                onValueChange={(v) => setForm({ ...form, managerId: v === 'none' ? '' : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="未设置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">（未设置）</SelectItem>
                  {allMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                      {m.jobTitle ? `（${m.jobTitle}）` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-sort">排序号（小在前）</Label>
              <Input
                id="dept-sort"
                type="number"
                min={0}
                value={form.sort}
                onChange={(e) => setForm({ ...form, sort: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
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

      <ImportResultDialog
        open={!!importResult}
        onOpenChange={(o) => !o && setImportResult(null)}
        result={importResult}
        title="人员导入结果"
      />

      {/* 成员新增/编辑弹窗 */}
      <MemberFormDialog
        open={memberFormOpen}
        onOpenChange={setMemberFormOpen}
        member={editingMember}
        memberDepartmentId={editingMember ? memberDeptMap.get(editingMember.id) ?? null : null}
        defaultDepartmentId={selected?.id ?? null}
        deptOptions={deptOptions}
        onSaved={refreshOrg}
      />
    </div>
  )
}
