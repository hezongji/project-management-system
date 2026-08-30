'use client'

/**
 * /settings 系统管理 —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * 仅 ADMIN 可见（非 ADMIN 显示无权限提示）。五个 tab + 数据清理：
 *   1. 用户管理：启停 / 改角色 / 调部门（GET/PATCH /admin/users）
 *   2. 审计日志：projectId/userId/action 筛选（GET /admin/audit-logs）
 *   3. 存储统计：按项目用量条形 + 全局总量（GET /admin/storage）
 *   4. 系统设置：注册开关 / 存储配额（GET/PATCH /admin/settings）
 *   5. 数据清理：五类垃圾数据统计 + 二次确认批量清理（GET /admin/cleanup-stats、POST /admin/cleanup）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import {
  ShieldAlert,
  Users,
  ShieldCheck,
  ScrollText,
  HardDrive,
  SlidersHorizontal,
  Search,
  Loader2,
  RefreshCw,
  Save,
  KeyRound,
  Pencil,
  Trash2,
  Eraser,
  Tags,
} from 'lucide-react'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { MobileSegmentedTabs } from '@/components/mobile/segmented-tabs'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { PermissionAssign } from '@/components/settings/permission-assign'
import { ExpenseCategoryManager } from '@/components/expense/category-manager'
import { DataTable } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/store/auth'
import { ApiError } from '@/services/api'
import { AdminService, AdminUser, AuditLog, StorageStats, AdminSettings, CleanupStats, CleanupType } from '@/services/admin'
import { OrgService } from '@/services/org'
import type { DeptNode } from '@/lib/org-tree'

// ───────────────────────────── 常量与工具 ─────────────────────────────

const ROLE_OPTIONS = [
  { value: 'ADMIN', label: '管理员' },
  { value: 'PROJECT_MANAGER', label: '项目经理' },
  { value: 'MEMBER', label: '成员' },
] as const

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理员',
  PROJECT_MANAGER: '项目经理',
  MEMBER: '成员',
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`
}

function flattenDepts(nodes: DeptNode[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = []
  const walk = (list: DeptNode[], depth: number) => {
    for (const n of list) {
      out.push({ id: n.id, name: (depth ? '　'.repeat(depth) + '└ ' : '') + n.name })
      walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

// ───────────────────────────── 页容器 ─────────────────────────────

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'

  if (!isAdmin) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">无权限访问</h1>
          <p className="text-sm text-muted-foreground">
            系统管理仅管理员（ADMIN）可见。如需访问，请联系管理员为你提升角色。
          </p>
        </CardContent>
      </Card>
    )
  }

  // 移动端 Tab 切换（S3-W5）：状态提升，桌面 Tabs / 移动 MobileSegmentedTabs 双分支
  const isMobile = useIsMobile()
  const [tab, setTab] = React.useState('users')

  const TAB_ITEMS = [
    { key: 'users', label: '用户管理' },
    { key: 'permissions', label: '权限分配' },
    { key: 'audit', label: '审计日志' },
    { key: 'storage', label: '存储统计' },
    { key: 'settings', label: '系统设置' },
    { key: 'expense-cats', label: '费用分类' },
    { key: 'cleanup', label: '数据清理' },
  ] as const

  return (
    <div className="space-y-4">
      <div className="border-b pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <SlidersHorizontal className="h-6 w-6" /> 系统管理
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          用户管理 / 审计日志 / 存储统计 / 系统设置 / 数据清理（仅管理员可见，§7.10）
        </p>
      </div>

      {isMobile ? (
        <div>
          <MobileSegmentedTabs tabs={TAB_ITEMS.map((t) => ({ key: t.key, label: t.label }))} active={tab} onChange={setTab} />
          <div className="mt-4">
            {tab === 'users' && <UsersTab />}
            {tab === 'permissions' && <PermissionAssign />}
            {tab === 'audit' && <AuditTab />}
            {tab === 'storage' && <StorageTab />}
            {tab === 'settings' && <SettingsTab />}
            {tab === 'expense-cats' && <ExpenseCategoryManager />}
            {tab === 'cleanup' && <CleanupTab />}
          </div>
        </div>
      ) : (
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full overflow-x-auto">
          <TabsTrigger value="users">
            <Users className="mr-1.5 h-4 w-4" /> 用户管理
          </TabsTrigger>
          <TabsTrigger value="permissions">
            <ShieldCheck className="mr-1.5 h-4 w-4" /> 权限分配
          </TabsTrigger>
          <TabsTrigger value="audit">
            <ScrollText className="mr-1.5 h-4 w-4" /> 审计日志
          </TabsTrigger>
          <TabsTrigger value="storage">
            <HardDrive className="mr-1.5 h-4 w-4" /> 存储统计
          </TabsTrigger>
          <TabsTrigger value="settings">
            <SlidersHorizontal className="mr-1.5 h-4 w-4" /> 系统设置
          </TabsTrigger>
          <TabsTrigger value="expense-cats">
            <Tags className="mr-1.5 h-4 w-4" /> 费用分类
          </TabsTrigger>
          <TabsTrigger value="cleanup">
            <Eraser className="mr-1.5 h-4 w-4" /> 数据清理
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionAssign />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="storage">
          <StorageTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="expense-cats">
          <ExpenseCategoryManager />
        </TabsContent>
        <TabsContent value="cleanup">
          <CleanupTab />
        </TabsContent>
      </Tabs>
      )}
    </div>
  )
}

// ───────────────────────────── Tab 1：用户管理 ─────────────────────────────

function UsersTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [q, setQ] = React.useState('')
  const [searchInput, setSearchInput] = React.useState('')

  // 重置密码弹窗（P1-5 兜底）
  const [resetTarget, setResetTarget] = React.useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<AdminUser | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [newPassword, setNewPassword] = React.useState('')
  const [resetting, setResetting] = React.useState(false)

  // 人员档案编辑弹窗（audit P1-3）
  const [editTarget, setEditTarget] = React.useState<AdminUser | null>(null)
  const [editForm, setEditForm] = React.useState({
    name: '',
    email: '',
    phone: '',
    jobTitle: '',
    duties: '',
    departmentId: 'none',
    role: 'MEMBER',
    isActive: true,
  })
  const [editSaving, setEditSaving] = React.useState(false)

  const { data: page, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['admin-users', q],
    queryFn: () => AdminService.getUsers({ q, page: 1, limit: 100 }),
  })

  const { data: deptTree } = useQuery({
    queryKey: ['departments'],
    queryFn: OrgService.getDepartments,
  })
  const departments = React.useMemo(() => flattenDepts(deptTree ?? []), [deptTree])

  const { data: jobTitles } = useQuery({
    queryKey: ['job-titles'],
    queryFn: OrgService.getJobTitles,
  })

  async function update(
    userId: string,
    payload: Omit<Parameters<typeof AdminService.updateUser>[0], 'userId'>
  ) {
    try {
      await AdminService.updateUser({ ...payload, userId })
      toast({ description: '用户已更新' })
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    } catch (err) {
      toast({
        title: '更新失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  async function handleResetPassword() {
    if (!resetTarget) return
    if (newPassword.length < 8) {
      toast({ title: '新密码至少需要 8 个字符', variant: 'destructive' })
      return
    }
    setResetting(true)
    try {
      await AdminService.resetUserPassword({ userId: resetTarget.id, newPassword })
      toast({ description: `已重置「${resetTarget.name}」的登录密码` })
      setResetTarget(null)
      setNewPassword('')
    } catch (err) {
      toast({
        title: '重置失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setResetting(false)
    }
  }

  /** 删除用户（离职人员）：有业务引用时后端 400 拒绝，提示改用停用 */
  async function handleDeleteUser() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await AdminService.deleteUser(deleteTarget.id)
      toast({ description: `已删除用户「${deleteTarget.name}」` })
      setDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  const openEdit = (u: AdminUser) => {
    setEditForm({
      name: u.name,
      email: u.email,
      phone: u.phone ?? '',
      jobTitle: u.jobTitle ?? '',
      duties: u.duties ?? '',
      departmentId: u.departmentId ?? 'none',
      role: u.role,
      isActive: u.isActive,
    })
    setEditTarget(u)
  }

  async function handleEditSave() {
    if (!editTarget) return
    if (!editForm.name.trim()) {
      toast({ title: '姓名不能为空', variant: 'destructive' })
      return
    }
    setEditSaving(true)
    try {
      await AdminService.updateUser({
        userId: editTarget.id,
        name: editForm.name.trim(),
        email: editForm.email.trim(),
        phone: editForm.phone.trim(),
        jobTitle: editForm.jobTitle.trim(),
        duties: editForm.duties.trim(),
        departmentId: editForm.departmentId === 'none' ? null : editForm.departmentId,
        role: editForm.role as AdminUser['role'],
        isActive: editForm.isActive,
      })
      toast({ description: '用户档案已更新' })
      setEditTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setEditSaving(false)
    }
  }

  const columns = React.useMemo<ColumnDef<AdminUser, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: '姓名',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">{row.original.username}</div>
          </div>
        ),
      },
      {
        accessorKey: 'email',
        header: '邮箱',
        meta: { className: 'hidden md:table-cell' },
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.email}</span>,
      },
      {
        accessorKey: 'jobTitle',
        header: '岗位',
        meta: { className: 'hidden lg:table-cell' },
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.jobTitle ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'role',
        header: '角色',
        cell: ({ row }) => (
          <Select
            value={row.original.role}
            onValueChange={(v) =>
              update(row.original.id, {
                role: v as AdminUser['role'],
              })
            }
          >
            <SelectTrigger className="h-8 w-[80px] sm:w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      },
      {
        accessorKey: 'departmentName',
        header: '部门',
        meta: { className: 'hidden md:table-cell' },
        cell: ({ row }) => (
          <Select
            value={row.original.departmentId ?? 'none'}
            onValueChange={(v) =>
              update(row.original.id, {
                departmentId: v === 'none' ? null : v,
              })
            }
          >
            <SelectTrigger className="h-8 w-[100px] sm:w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">未分配</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      },
      {
        accessorKey: 'isActive',
        header: '状态',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Switch
              checked={row.original.isActive}
              onCheckedChange={(v) =>
                update(row.original.id, { isActive: v })
              }
            />
            {row.original.isActive ? (
              <Badge variant="secondary">在职</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                已停用
              </Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'lastLoginAt',
        header: '最近登录',
        meta: { className: 'hidden lg:table-cell' },
        cell: ({ row }) => (
          <span className="text-muted-foreground">{fmtDate(row.original.lastLoginAt)}</span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => openEdit(row.original)} className="px-2">
              <Pencil className="h-3.5 w-3.5" /> <span className="hidden sm:inline">编辑</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="px-2"
              onClick={() => {
                setResetTarget(row.original)
                setNewPassword('')
              }}
            >
              <KeyRound className="h-3.5 w-3.5" /> <span className="hidden sm:inline">重置密码</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="px-2 text-destructive hover:text-destructive"
              onClick={() => setDeleteTarget(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">删除</span>
            </Button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [departments]
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault()
            setQ(searchInput.trim())
          }}
        >
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索姓名 / 邮箱 / 用户名"
            className="w-full sm:w-64"
          />
          <Button type="submit" size="sm" variant="outline">
            <Search className="mr-1 h-4 w-4" /> 搜索
          </Button>
        </form>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw className={isRefetching ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'} />
          刷新
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={page?.items ?? []}
        loading={isLoading}
        empty="暂无用户"
      />
      <p className="text-xs text-muted-foreground">
        共 {page?.pagination?.total ?? 0} 名用户。角色/部门调整与启停即时生效（最后一名 ADMIN 不可降级或停用）。
      </p>

      <Dialog open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为「{resetTarget?.name}」（{resetTarget?.email}）设置新登录密码，保存后立即生效。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reset-pwd">新密码（至少 8 个字符）</Label>
            <Input
              id="reset-pwd"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="请输入新密码"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={handleResetPassword} disabled={resetting}>
              {resetting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除用户（离职人员）确认弹窗 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">删除用户</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.name}」（{deleteTarget?.email}）吗？
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                若该用户存在项目/任务/文件等业务引用，系统将拒绝删除，请先改用「停用」。
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 人员档案编辑弹窗（audit P1-3：姓名/邮箱/手机/岗位/职责/部门/角色/启停） */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑用户档案</DialogTitle>
            <DialogDescription>
              {editTarget?.username} · PATCH /api/admin/users（姓名/邮箱/岗位/职责等字段）
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="eu-name">姓名 *</Label>
                <Input
                  id="eu-name"
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={50}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="eu-phone">手机</Label>
                <Input
                  id="eu-phone"
                  value={editForm.phone}
                  onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                  maxLength={20}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="eu-email">邮箱（登录账号）</Label>
              <Input
                id="eu-email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                maxLength={200}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="eu-jobtitle">岗位</Label>
                <Input
                  id="eu-jobtitle"
                  list="jobtitle-options"
                  value={editForm.jobTitle}
                  onChange={(e) => setEditForm((f) => ({ ...f, jobTitle: e.target.value }))}
                  maxLength={50}
                  placeholder="选择或输入岗位"
                />
                <datalist id="jobtitle-options">
                  {(jobTitles ?? []).map((j) => (
                    <option key={j.id} value={j.name} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="eu-dept">部门</Label>
                <Select
                  value={editForm.departmentId}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, departmentId: v }))}
                >
                  <SelectTrigger id="eu-dept">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未分配</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="eu-duties">职责描述</Label>
              <Textarea
                id="eu-duties"
                rows={2}
                value={editForm.duties}
                onChange={(e) => setEditForm((f) => ({ ...f, duties: e.target.value }))}
                maxLength={500}
                placeholder="如：原职务：电气工程师"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="grid gap-1.5">
                <Label>全局角色</Label>
                <Select
                  value={editForm.role}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, role: v }))}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="eu-active">在职</Label>
                <Switch
                  id="eu-active"
                  checked={editForm.isActive}
                  onCheckedChange={(v) => setEditForm((f) => ({ ...f, isActive: v }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={handleEditSave} disabled={editSaving}>
              {editSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ───────────────────────────── Tab 2：审计日志 ─────────────────────────────

function AuditTab() {
  const [projectId, setProjectId] = React.useState('')
  const [userId, setUserId] = React.useState('')
  const [action, setAction] = React.useState('')
  const [applied, setApplied] = React.useState({ projectId: '', userId: '', action: '' })

  const { data: page, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['admin-audit', applied],
    queryFn: () => AdminService.getAuditLogs({ ...applied, page: 1, limit: 50 }),
  })

  const { data: projects } = useQuery({
    queryKey: ['admin-project-options'],
    queryFn: AdminService.getProjectOptions,
  })
  const { data: usersPage } = useQuery({
    queryKey: ['admin-audit-users'],
    queryFn: () => AdminService.getUsers({ page: 1, limit: 200 }),
  })
  const users = usersPage?.items ?? []

  const columns = React.useMemo<ColumnDef<AuditLog, unknown>[]>(
    () => [
      {
        accessorKey: 'createdAt',
        header: '时间',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {fmtDate(row.original.createdAt)}
          </span>
        ),
      },
      {
        accessorKey: 'userName',
        header: '用户',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.userName ?? '—'}</div>
            <div className="text-xs text-muted-foreground">{row.original.userEmail ?? ''}</div>
          </div>
        ),
      },
      {
        accessorKey: 'action',
        header: '动作',
        cell: ({ row }) => (
          <Badge variant="secondary" className="font-mono text-[11px]">
            {row.original.action}
          </Badge>
        ),
      },
      {
        accessorKey: 'projectName',
        header: '项目',
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.projectName ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'detail',
        header: '明细',
        cell: ({ row }) => {
          const d = row.original.detail
          const text = d == null ? '—' : typeof d === 'string' ? d : JSON.stringify(d)
          return (
            <span className="block max-w-[320px] truncate font-mono text-xs text-muted-foreground" title={text}>
              {text}
            </span>
          )
        },
      },
    ],
    []
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">项目</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="全部项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">用户</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="全部用户" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部用户</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">动作（模糊）</Label>
          <Input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="如 project.create"
            className="h-9 w-48"
          />
        </div>
        <Button
          size="sm"
          onClick={() =>
            setApplied({
              projectId: projectId === 'all' ? '' : projectId,
              userId: userId === 'all' ? '' : userId,
              action: action.trim(),
            })
          }
        >
          <Search className="mr-1 h-4 w-4" /> 筛选
        </Button>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className="mr-1 h-4 w-4" /> 刷新
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={page?.items ?? []}
        loading={isLoading}
        empty="暂无审计记录"
      />
      <p className="text-xs text-muted-foreground">
        共 {page?.pagination?.total ?? 0} 条（按时间倒序，最多展示 50 条）。
      </p>
    </div>
  )
}

// ───────────────────────────── Tab 3：存储统计 ─────────────────────────────

function StorageTab() {
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['admin-storage'],
    queryFn: AdminService.getStorage,
  })

  const stats: StorageStats | undefined = data
  const quota = stats?.quotaPerProjectBytes ?? 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          口径：按项目聚合 File 表 size 字段；配额来源 SystemSetting.storageQuotaPerProjectBytes（默认 10GB/项目）。
        </p>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className="mr-1 h-4 w-4" /> 刷新
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">全局文件总量</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {stats ? fmtBytes(stats.totalBytes) : '—'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">全局文件数</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {stats ? `${stats.totalFileCount} 个` : '—'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">单项目配额</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {stats ? fmtBytes(stats.quotaPerProjectBytes) : '—'}
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : (
        <div className="space-y-3 rounded-md border p-4">
          {!stats || stats.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无文件数据</p>
          ) : (
            stats.items.map((it) => {
              const pct = quota > 0 ? Math.min(100, Math.round((it.totalBytes / quota) * 100)) : 0
              return (
                <div key={it.projectId}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{it.projectName}</span>
                    <span className="text-muted-foreground">
                      {it.fileCount} 个文件 · {fmtBytes(it.totalBytes)} / {fmtBytes(it.quotaBytes)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── Tab 4：系统设置 ─────────────────────────────

function SettingsTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: AdminService.getSettings,
  })

  const [registerEnabled, setRegisterEnabled] = React.useState(true)
  const [quotaGb, setQuotaGb] = React.useState('10')

  React.useEffect(() => {
    if (settings) {
      setRegisterEnabled(settings.registerEnabled)
      setQuotaGb(String(Math.round(settings.storageQuotaPerProjectBytes / 1024 ** 3)))
    }
  }, [settings])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const gb = Number(quotaGb)
    if (!Number.isFinite(gb) || gb <= 0) {
      toast({ title: '配额需为正数（GB）', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      await AdminService.updateSettings({
        registerEnabled,
        storageQuotaPerProjectBytes: Math.round(gb * 1024 ** 3),
      })
      toast({ description: '系统设置已保存' })
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
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

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
      </div>
    )
  }

  return (
    <form onSubmit={handleSave} className="max-w-xl space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>注册开关</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">允许新用户注册</p>
            <p className="text-xs text-muted-foreground">
              关闭后 /api/auth/register 将拒绝注册（提示「注册已关闭」）。
            </p>
          </div>
          <Switch checked={registerEnabled} onCheckedChange={setRegisterEnabled} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>存储配额</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="quota-gb">单项目配额（GB）</Label>
          <Input
            id="quota-gb"
            type="number"
            min={1}
            value={quotaGb}
            onChange={(e) => setQuotaGb(e.target.value)}
            className="w-48"
          />
          <p className="text-xs text-muted-foreground">
            当前值：{settings ? fmtBytes(settings.storageQuotaPerProjectBytes) : '—'}
          </p>
        </CardContent>
      </Card>

      <Button type="submit" disabled={saving}>
        {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        <Save className="mr-1 h-4 w-4" /> 保存设置
      </Button>
    </form>
  )
}

// ───────────────────── Tab 5：数据清理（删除工程 t7：ADMIN 垃圾数据批量清理） ─────────────────────

/** 五类可清理垃圾的展示元数据（与后端 CLEANUP_TYPES 同步） */
const CLEANUP_META: Array<{
  type: CleanupType
  title: string
  desc: string
}> = [
  {
    type: 'draftPurchaseOrders',
    title: '草稿采购订单',
    desc: '状态为草稿（DRAFT）且无付款流水、无追加单、无已确认到货的采购订单；删除时会自动解链对应的采购需求使其可重新转单。',
  },
  {
    type: 'emptyProjects',
    title: '空项目',
    desc: '创建超过 30 天且无阶段、无成员、无任务/文件/采购等任何业务数据的项目。',
  },
  {
    type: 'emptyPhases',
    title: '空阶段',
    desc: '无任务且无文件条目关联的阶段。',
  },
  {
    type: 'unusedExternalOrgs',
    title: '未使用外部主体',
    desc: '无项目、订单、采购需求、到货关联的外部主体（客户/供应商等档案，联系人一并删除）。',
  },
  {
    type: 'orphanFiles',
    title: '孤儿文件记录',
    desc: '未关联任何交付条目的文件记录（含计划外临时上传与条目删除后的残留，访问日志一并清除）。',
  },
]

function CleanupTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState<CleanupType | null>(null)
  const [cleaning, setCleaning] = React.useState(false)

  const { data: stats, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['admin-cleanup-stats'],
    queryFn: AdminService.getCleanupStats,
  })

  const current = CLEANUP_META.find((m) => m.type === pending)
  const currentCount = stats && pending ? stats[pending] : 0

  async function handleConfirm() {
    if (!pending) return
    setCleaning(true)
    try {
      const res = await AdminService.runCleanup(pending)
      toast({ description: `清理完成：已删除 ${res.deleted} 条` })
      setPending(null)
      await queryClient.invalidateQueries({ queryKey: ['admin-cleanup-stats'] })
    } catch (err) {
      toast({
        title: '清理失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
      setPending(null)
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          统计各类可清理的垃圾数据，逐类二次确认后批量删除；每改操作均写入审计日志（仅 ADMIN）。
          删除不可恢复，请确认数量后再执行。
        </p>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={isRefetching ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'} /> 刷新
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CLEANUP_META.map((m) => {
            const count = stats ? stats[m.type] : 0
            return (
              <Card key={m.type} className="flex flex-col">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm font-medium">
                    {m.title}
                    <span className="text-2xl font-semibold tabular-nums">{stats ? count : '—'}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">{m.desc}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start text-destructive hover:text-destructive"
                    disabled={count === 0}
                    onClick={() => setPending(m.type)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 清理
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        判定口径与删除动作在同一事务内按当前数据实时计算，重复执行不会多删（幂等）；
        文件记录删除后磁盘物理文件需另行运维清理。
      </p>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && !cleaning && setPending(null)}
        title={`确认清理「${current?.title ?? ''}」`}
        description={`本次将删除 ${currentCount} 条「${current?.title ?? ''}」${currentCount > 0 ? '及其级联数据' : ''}，操作不可恢复，是否继续？—— ${current?.desc ?? ''}`}
        confirmText="确认清理"
        destructive
        loading={cleaning}
        onConfirm={handleConfirm}
      />
    </div>
  )
}
