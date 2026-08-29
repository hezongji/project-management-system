'use client'

/**
 * 项目权限矩阵弹窗（audit P1-2）—— ACL（ResourcePermission）可视化管理
 *
 * 数据：GET/PUT /api/projects/:id/permissions
 * 主体：USER（部门树内在职成员）/ DEPARTMENT（部门树）/ ROLE（项目角色 ∪ 全局角色）
 * 八键：view/edit/delete/assign/upload/download/approve/archive（lib/permission.ts Action）
 * 语义：ACL 为 ∪ 追加授权（不设减权），覆盖式保存（PUT 全量替换）。
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { ApiService } from '@/services/api'
import { OrgService } from '@/services/org'
import type { DeptNode } from '@/lib/org-tree'

type PrincipalType = 'USER' | 'DEPARTMENT' | 'ROLE'

const ACTIONS = [
  'view',
  'edit',
  'delete',
  'assign',
  'upload',
  'download',
  'approve',
  'archive',
] as const
type ActionKey = (typeof ACTIONS)[number]
type PermRow = Record<ActionKey, boolean>

const ACTION_LABEL: Record<ActionKey, string> = {
  view: '查看',
  edit: '编辑',
  delete: '删除',
  assign: '指派',
  upload: '上传',
  download: '下载',
  approve: '审批',
  archive: '归档',
}

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'OWNER', label: '项目负责人（OWNER）' },
  { value: 'MANAGER', label: '项目经理（MANAGER）' },
  { value: 'MEMBER', label: '项目成员（MEMBER）' },
  { value: 'VIEWER', label: '项目访客（VIEWER）' },
  { value: 'ADMIN', label: '系统管理员（ADMIN）' },
  { value: 'PROJECT_MANAGER', label: '项目经理（全局）' },
]

interface GrantRow {
  key: string
  principalType: PrincipalType
  principalId: string
  principalName: string
  perms: PermRow
}

function blankPerms(): PermRow {
  const p = {} as PermRow
  for (const a of ACTIONS) p[a] = false
  return p
}

function normalizePerms(raw: unknown): PermRow {
  const p = blankPerms()
  if (raw && typeof raw === 'object') {
    for (const a of ACTIONS) {
      if ((raw as Record<string, unknown>)[a] === true) p[a] = true
    }
  }
  return p
}

function flattenDepts(nodes: DeptNode[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = []
  const walk = (list: DeptNode[]) => {
    for (const n of list) {
      out.push({ id: n.id, name: n.name })
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

function flattenMembers(
  nodes: DeptNode[],
  path = '',
): { id: string; name: string; dept: string }[] {
  const out: { id: string; name: string; dept: string }[] = []
  for (const n of nodes) {
    const p = path ? `${path} / ${n.name}` : n.name
    for (const m of n.members) {
      if (m.isActive) out.push({ id: m.id, name: m.name, dept: p })
    }
    out.push(...flattenMembers(n.children, p))
  }
  return out
}

export function PermissionMatrixDialog({
  projectId,
  projectCode,
  open,
  onOpenChange,
}: {
  projectId: string
  projectCode: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const [rows, setRows] = React.useState<GrantRow[]>([])
  const [saving, setSaving] = React.useState(false)

  // 新增授权行的选择状态
  const [addType, setAddType] = React.useState<PrincipalType>('USER')
  const [addId, setAddId] = React.useState('')

  const { data: grantData, isLoading } = useQuery({
    queryKey: ['project-permissions', projectId],
    queryFn: () =>
      ApiService.get<{
        grants: {
          principalType: PrincipalType
          principalId: string
          principalName: string
          perms: unknown
        }[]
      }>(`/projects/${projectId}/permissions`).then((r) => r.data?.grants ?? []),
    enabled: open,
  })

  const { data: deptTree } = useQuery({
    queryKey: ['departments-tree'],
    queryFn: OrgService.getDepartments,
    enabled: open,
  })

  React.useEffect(() => {
    if (!grantData) return
    setRows(
      grantData.map((g) => ({
        key: `${g.principalType}:${g.principalId}`,
        principalType: g.principalType,
        principalId: g.principalId,
        principalName: g.principalName,
        perms: normalizePerms(g.perms),
      })),
    )
  }, [grantData])

  const users = React.useMemo(() => flattenMembers(deptTree ?? []), [deptTree])
  const depts = React.useMemo(() => flattenDepts(deptTree ?? []), [deptTree])

  const addOptions =
    addType === 'USER' ? users.map((u) => ({ value: u.id, label: `${u.name}（${u.dept}）` }))
    : addType === 'DEPARTMENT' ? depts.map((d) => ({ value: d.id, label: d.name }))
    : ROLE_OPTIONS

  const existingKeys = new Set(rows.map((r) => r.key))

  const addRow = () => {
    if (!addId) return
    const key = `${addType}:${addId}`
    if (existingKeys.has(key)) {
      toast({ description: '该主体已在授权列表中', variant: 'destructive' })
      return
    }
    const name =
      addType === 'USER'
        ? users.find((u) => u.id === addId)?.name ?? addId
        : addType === 'DEPARTMENT'
          ? depts.find((d) => d.id === addId)?.name ?? addId
          : ROLE_OPTIONS.find((r) => r.value === addId)?.label ?? addId
    setRows((prev) => [
      ...prev,
      { key, principalType: addType, principalId: addId, principalName: name, perms: blankPerms() },
    ])
    setAddId('')
  }

  const toggle = (key: string, action: ActionKey) => {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key ? { ...r, perms: { ...r.perms, [action]: !r.perms[action] } } : r,
      ),
    )
  }

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  const save = async () => {
    setSaving(true)
    try {
      // 全空行不提交（等价于无授权）
      const grants = rows
        .filter((r) => ACTIONS.some((a) => r.perms[a]))
        .map((r) => ({
          principalType: r.principalType,
          principalId: r.principalId,
          perms: r.perms,
        }))
      await ApiService.put(`/projects/${projectId}/permissions`, { grants })
      toast({ description: '权限矩阵已保存' })
      onOpenChange(false)
    } catch (e) {
      toast({
        title: '保存失败',
        description: e instanceof Error ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            权限矩阵（ACL 追加授权）
          </DialogTitle>
          <DialogDescription>
            {projectCode} · 覆盖式保存（PUT /api/projects/:id/permissions）。ACL 为追加授权：
            勾选的权限将与成员角色基线合并（∪），不设减权。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载授权…
          </div>
        ) : (
          <div className="space-y-3">
            {/* 新增授权 */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2">
              <Select
                value={addType}
                onValueChange={(v) => {
                  setAddType(v as PrincipalType)
                  setAddId('')
                }}
              >
                <SelectTrigger className="h-8 w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">人员</SelectItem>
                  <SelectItem value="DEPARTMENT">部门</SelectItem>
                  <SelectItem value="ROLE">角色</SelectItem>
                </SelectContent>
              </Select>
              <Select value={addId} onValueChange={setAddId}>
                <SelectTrigger className="h-8 w-[260px]">
                  <SelectValue placeholder="选择授权对象" />
                </SelectTrigger>
                <SelectContent>
                  {addOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} disabled={existingKeys.has(`${addType}:${o.value}`)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={addRow} disabled={!addId}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                添加
              </Button>
            </div>

            {/* 授权矩阵表 */}
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                暂无 ACL 授权（成员权限由角色基线决定）
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">授权对象</th>
                      {ACTIONS.map((a) => (
                        <th key={a} className="px-2 py-2 text-center font-medium">
                          {ACTION_LABEL[a]}
                        </th>
                      ))}
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className="border-b last:border-b-0">
                        <td className="max-w-[220px] truncate px-3 py-2">
                          <span className="font-medium">{r.principalName}</span>
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {r.principalType === 'USER' ? '人员' : r.principalType === 'DEPARTMENT' ? '部门' : '角色'}
                          </span>
                        </td>
                        {ACTIONS.map((a) => (
                          <td key={a} className="px-2 py-2 text-center">
                            <Checkbox
                              checked={r.perms[a]}
                              onCheckedChange={() => toggle(r.key, a)}
                              aria-label={`${r.principalName} ${ACTION_LABEL[a]}`}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => removeRow(r.key)}
                            title="移除此授权"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving || isLoading}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存授权
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
