'use client'

/**
 * 权限分配面板（权限 V2 2026-08-21）
 *
 * 管理员统一为每个用户分配可见范围：
 *   - 页面权限：勾选该用户可见的系统页面（全系统页面清单）
 *   - 额外可见项目：超出项目成员制的授权可见项目
 *   - 财务 / 外部主体数据权限由「角色 + 项目角色」自动派生，此处只读展示说明
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Loader2,
  Lock,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { AdminService } from '@/services/admin'
import { ApiService } from '@/services/api'
import { ALL_PAGES, defaultPagesForRole } from '@/lib/page-permissions'
import { ExternalOrgScopeConfig } from '@/components/settings/external-org-scope-config'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理员',
  PROJECT_MANAGER: '项目经理',
  MEMBER: '成员',
}

/** 页面按分组展示 */
const PAGE_GROUPS = Array.from(
  new Set(ALL_PAGES.map((p) => p.group)),
).map((group) => ({
  group,
  pages: ALL_PAGES.filter((p) => p.group === group),
}))

export function PermissionAssign() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [tab, setTab] = React.useState<'users' | 'external'>('users')

  // 用户列表（复用 admin/users）
  const { data: usersPage, isLoading } = useQuery({
    queryKey: ['admin-users-perm'],
    queryFn: () => AdminService.getUsers({ limit: 200 }),
  })

  const users = usersPage?.items ?? []
  const filtered = users.filter((u) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      u.name.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q) ||
      (u.departmentName ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4">
      {/* Tab 切换：用户授权 / 外部主体可见性 */}
      <div className="inline-flex rounded-md border border-input p-1">
        {(
          [
            ['users', '用户授权'],
            ['external', '外部主体可见性'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'rounded px-4 py-1.5 text-sm transition-colors',
              tab === k
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'external' ? (
        <ExternalOrgScopeConfig />
      ) : (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* 左：用户列表 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">用户列表</CardTitle>
          <Input
            placeholder="搜索姓名 / 账号 / 部门..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8"
          />
        </CardHeader>
        <CardContent className="p-2">
          <div className="h-[52vh] space-y-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-1">
                {filtered.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedId(u.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/60',
                      selectedId === u.id && 'bg-primary/10 text-primary',
                    )}
                  >
                    <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{u.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {u.username} · {u.departmentName ?? '未分配部门'}
                      </span>
                    </span>
                    <Badge variant={u.role === 'ADMIN' ? 'default' : 'secondary'}>
                      {ROLE_LABEL[u.role] ?? u.role}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 右：权限配置 */}
      <Card>
        {selectedId ? (
          <PermissionPanel userId={selectedId} onSaved={() => queryClient.invalidateQueries()} />
        ) : (
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <ShieldCheck className="h-10 w-10" />
            <p className="text-sm">从左侧选择一位用户，配置其可见页面与数据范围</p>
            <p className="max-w-md text-xs">
              页面权限：控制该用户能看到哪些系统页面（侧边栏菜单 + 直接 URL 访问均生效）。
              数据权限：项目列表仅成员可见、财务脱敏、外部主体按类型可见性（自动规则）。
            </p>
          </CardContent>
        )}
      </Card>
    </div>
      )}
    </div>
  )
}

// ───────────────────────────── 单个用户权限面板 ─────────────────────────────

function PermissionPanel({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast()
  const [saving, setSaving] = React.useState(false)
  const [pageKeys, setPageKeys] = React.useState<string[] | null>(null) // null = 按角色默认
  const [extraProjectIds, setExtraProjectIds] = React.useState<string[]>([])
  const [projectSearch, setProjectSearch] = React.useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['user-permissions', userId],
    queryFn: () => AdminService.getUserPermissions(userId),
  })

  // 加载后初始化（组件内 state 跟随数据源）
  React.useEffect(() => {
    if (data) {
      setPageKeys(data.config.pagePermissions)
      setExtraProjectIds(data.config.extraVisibleProjectIds ?? [])
    }
  }, [data])

  // 项目选项（搜索）
  const { data: projectsData } = useQuery({
    queryKey: ['all-projects-for-perm', projectSearch],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; name: string; code: string }> }>(
        `/projects?search=${encodeURIComponent(projectSearch)}&limit=30`,
      ).then((r) => r.data?.items ?? []),
    enabled: !!projectSearch,
  })
  const projectOptions = projectsData ?? []

  if (isLoading || !data) {
    return (
      <CardContent className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </CardContent>
    )
  }

  const { user, config } = data
  const isAdminUser = user.role === 'ADMIN'
  const effectivePages = isAdminUser
    ? ALL_PAGES.map((p) => p.key)
    : pageKeys === null
      ? defaultPagesForRole(user.role)
      : pageKeys

  const togglePage = (key: string) => {
    if (isAdminUser) return
    setPageKeys((prev) => {
      const base = prev === null ? defaultPagesForRole(user.role) : [...prev]
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
    })
  }

  const resetPages = () => setPageKeys(null)

  const save = async () => {
    setSaving(true)
    try {
      await AdminService.saveUserPermissions(userId, {
        pagePermissions: isAdminUser ? null : pageKeys,
        extraVisibleProjectIds: extraProjectIds,
      })
      toast({ description: '权限已保存 ✓' })
      onSaved()
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <CardHeader className="border-b pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              {user.name}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                @{user.username} · {user.departmentName ?? '未分配部门'}
              </span>
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              角色：{ROLE_LABEL[user.role] ?? user.role}
              {!user.isActive && <Badge variant="destructive" className="ml-2">已停用</Badge>}
            </p>
          </div>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            保存
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* 页面权限 */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-sm font-semibold">可见页面</Label>
            {!isAdminUser && pageKeys !== null && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={resetPages}>
                恢复角色默认
              </Button>
            )}
          </div>
          {isAdminUser ? (
            <p className="flex items-center gap-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" /> 管理员（ADMIN）恒可见全部页面，不可降级
            </p>
          ) : (
            <div className="space-y-3">
              {PAGE_GROUPS.map((g) => (
                <div key={g.group}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.group}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {g.pages.map((p) => {
                      const on = effectivePages.includes(p.key)
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => togglePage(p.key)}
                          className={cn(
                            'rounded-md border px-2.5 py-1 text-xs transition-colors',
                            on
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                          )}
                        >
                          {on && '✓ '}
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              {pageKeys === null && (
                <p className="text-[11px] text-muted-foreground">
                  当前为「按角色默认」配置，修改任意页面即进入自定义模式
                </p>
              )}
            </div>
          )}
        </div>

        {/* 额外可见项目 */}
        <div>
          <Label className="text-sm font-semibold">额外可见项目（超出成员制）</Label>
          <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
            该用户默认可见其成员项目；此处可额外授权其查看指定项目（只读可见，不参与项目工作流）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {extraProjectIds.map((id) => (
              <Badge
                key={id}
                variant="secondary"
                className="cursor-pointer gap-1"
                onClick={() => setExtraProjectIds((prev) => prev.filter((x) => x !== id))}
                title="点击移除"
              >
                {id.slice(0, 8)}…
                <span className="text-muted-foreground">✕</span>
              </Badge>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              placeholder="搜索项目名称添加授权..."
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          {projectSearch && (
            <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-md border p-1.5">
              {projectOptions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={extraProjectIds.includes(p.id)}
                  onClick={() => {
                    setExtraProjectIds((prev) => [...prev, p.id])
                    setProjectSearch('')
                  }}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted/60 disabled:opacity-40"
                >
                  <span className="truncate">
                    {p.code} · {p.name}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              ))}
              {projectOptions.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">无匹配项目</p>
              )}
            </div>
          )}
        </div>

        {/* 数据权限说明 */}
        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">自动数据权限规则（无需配置）</p>
          <ul className="list-inside list-disc space-y-0.5">
            <li>项目列表：仅项目成员可见（ADMIN 全量）</li>
            <li>财务数据：仅 ADMIN / 财务部 / 项目 OWNER・MANAGER 可见金额与合同号</li>
            <li>供应商名单：仅采购部可见</li>
            <li>文件条目：按条目范围（公开/受限/私密）控制查看与下载</li>
          </ul>
        </div>
      </CardContent>
    </div>
  )
}
