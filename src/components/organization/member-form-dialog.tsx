'use client'

/**
 * MemberFormDialog —— 成员新增/编辑弹窗（组织架构增强）
 *
 * 新增：姓名*、邮箱*、用户名（缺省邮箱前缀）、初始密码（≥6位必填）、
 *       手机、部门、岗位（岗位字典联想）、职责、角色 → POST /api/admin/users
 * 编辑：同上（不含用户名/密码）+ 启停开关 → PATCH /api/admin/users
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { OrgService, type DeptMemberBrief } from '@/services/org'
import { AdminService } from '@/services/admin'
import { ApiError } from '@/services/api'

type Role = 'ADMIN' | 'PROJECT_MANAGER' | 'MEMBER'

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: '管理员',
  PROJECT_MANAGER: '项目管理员',
  MEMBER: '成员',
}

export interface MemberFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = 新增；否则编辑该成员 */
  member: DeptMemberBrief | null
  /** 编辑时该成员的当前部门 id（DeptMemberBrief 无此字段，由页面从树中推导） */
  memberDepartmentId?: string | null
  /** 默认部门（新增时预填当前选中部门） */
  defaultDepartmentId?: string | null
  /** 部门下拉选项（id → 层级路径） */
  deptOptions: Array<{ id: string; path: string }>
  /** 保存成功后回调（刷新部门树等） */
  onSaved?: () => void
}

interface FormState {
  name: string
  email: string
  username: string
  password: string
  phone: string
  departmentId: string
  jobTitle: string
  duties: string
  role: Role
  isActive: boolean
}

export function MemberFormDialog({
  open,
  onOpenChange,
  member,
  memberDepartmentId,
  defaultDepartmentId,
  deptOptions,
  onSaved,
}: MemberFormDialogProps) {
  const { toast } = useToast()
  const isEdit = !!member
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>({
    name: '',
    email: '',
    username: '',
    password: '',
    phone: '',
    departmentId: '',
    jobTitle: '',
    duties: '',
    role: 'MEMBER',
    isActive: true,
  })

  /** 岗位字典（岗位输入联想） */
  const { data: jobTitles } = useQuery({
    queryKey: ['job-titles'],
    queryFn: OrgService.getJobTitles,
    enabled: open,
  })

  // 打开时初始化表单
  React.useEffect(() => {
    if (!open) return
    if (member) {
      setForm({
        name: member.name,
        email: member.email,
        username: '',
        password: '',
        phone: member.phone ?? '',
        departmentId: memberDepartmentId ?? '',
        jobTitle: member.jobTitle ?? '',
        duties: member.duties ?? '',
        role: member.role,
        isActive: member.isActive,
      })
    } else {
      setForm({
        name: '',
        email: '',
        username: '',
        password: '',
        phone: '',
        departmentId: defaultDepartmentId ?? '',
        jobTitle: '',
        duties: '',
        role: 'MEMBER',
        isActive: true,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member?.id, memberDepartmentId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      toast({ title: '请填写姓名', variant: 'destructive' })
      return
    }
    if (!isEdit && form.password.trim().length < 6) {
      toast({ title: '请设置至少 6 位初始密码', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      if (isEdit && member) {
        await AdminService.updateUser({
          userId: member.id,
          name: form.name.trim(),
          phone: form.phone.trim() || null,
          jobTitle: form.jobTitle.trim() || null,
          duties: form.duties.trim() || null,
          role: form.role,
          isActive: form.isActive,
          ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        })
        toast({ description: '成员信息已更新' })
      } else {
        await AdminService.createUser({
          name: form.name.trim(),
          username: form.username.trim() || undefined,
          password: form.password.trim(),
          phone: form.phone.trim() || null,
          departmentId: form.departmentId || null,
          jobTitle: form.jobTitle.trim() || null,
          duties: form.duties.trim() || null,
          role: form.role,
        })
        toast({ description: '成员已创建' })
      }
      onOpenChange(false)
      onSaved?.()
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑成员 · ${member?.name}` : '新增成员'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改成员档案、部门归属与启停状态。'
              : '用户名为姓名全拼（留空自动生成）；请设置初始密码。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-name">姓名 *</Label>
              <Input
                id="m-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：张三"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-username">用户名（登录账号，姓名全拼）</Label>
              <Input
                id="m-username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="如：zhangsan（留空则自动生成）"
              />
            </div>
          </div>

          {!isEdit && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="m-password">初始密码</Label>
                <Input
                  id="m-password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="至少 6 位"
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-phone">手机</Label>
              <Input
                id="m-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="可选"
              />
            </div>
            <div className="space-y-1.5">
              <Label>部门</Label>
              <select
                value={form.departmentId || 'none'}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value === 'none' ? '' : e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="none">{isEdit ? '（不调整）' : '（未分配）'}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.path}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-jobtitle">岗位</Label>
              <Input
                id="m-jobtitle"
                value={form.jobTitle}
                onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
                placeholder="如：电气工程师"
                list="jobtitle-options"
              />
              <datalist id="jobtitle-options">
                {(jobTitles ?? []).map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label>角色</Label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="m-duties">职责描述</Label>
            <Textarea
              id="m-duties"
              rows={2}
              value={form.duties}
              onChange={(e) => setForm({ ...form, duties: e.target.value })}
              placeholder="可选，如：负责电气原理图设计与评审"
            />
          </div>

          {isEdit && (
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div>
                <Label>在职状态</Label>
                <p className="text-xs text-muted-foreground">停用后无法登录，且不参与排期与统计</p>
              </div>
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {isEdit ? '保存' : '创建成员'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
