'use client'

/**
 * 问题上报表单（§8.2⑥ / §7.8 POST /issues）
 *
 * 独立可复用组件：可挂载于消息页 / 项目页 / 弹窗，提交后 POST /api/issues，
 * 成功触发 onSuccess 回调（拿到 issueId/conversationId/taskId）并清空表单。
 * 本组件不依赖页面级状态，可独立引入。
 *
 * 数据源：
 *   - 所属项目：GET /api/projects（取 data.items）
 *   - 指派给：GET /api/users（接口缺失时优雅降级为空列表）
 */

import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { api } from '@/services/api-instance'
import { cn } from '@/lib/utils'

type Urgency = 'HIGH' | 'MEDIUM' | 'LOW'

interface ProjectOption {
  id: string
  name: string
  code?: string
}

interface UserOption {
  id: string
  name: string
  email?: string
}

export interface IssueFormResult {
  issueId: string
  conversationId: string
  taskId: string
}

interface IssueFormProps {
  /** 默认选中的项目（可选，挂载于项目页时传入） */
  defaultProjectId?: string
  /** 提交成功回调 */
  onSuccess?: (data: IssueFormResult) => void
  /** 取消/关闭回调（传入则显示取消按钮） */
  onCancel?: () => void
  className?: string
}

export function IssueForm({
  defaultProjectId,
  onSuccess,
  onCancel,
  className,
}: IssueFormProps) {
  const { toast } = useToast()
  const [title, setTitle] = React.useState('')
  const [urgency, setUrgency] = React.useState<Urgency>('MEDIUM')
  const [projectId, setProjectId] = React.useState<string>(defaultProjectId ?? '')
  const [desc, setDesc] = React.useState('')
  const [assigneeId, setAssigneeId] = React.useState<string>('')
  const [projects, setProjects] = React.useState<ProjectOption[]>([])
  const [users, setUsers] = React.useState<UserOption[]>([])
  const [submitting, setSubmitting] = React.useState(false)

  // 同步外部默认项目
  React.useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId)
  }, [defaultProjectId])

  // 所属项目下拉：GET /api/projects（分页，取 items）
  React.useEffect(() => {
    let cancelled = false
    api
      .get('/projects', { params: { limit: 100 } })
      .then((res) => {
        if (cancelled) return
        const items = res?.data?.data?.items ?? []
        setProjects(Array.isArray(items) ? items : [])
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 指派给下拉：GET /api/users（接口缺失时优雅降级为空列表）
  React.useEffect(() => {
    let cancelled = false
    api
      .get('/users', { params: { limit: 100 } })
      .then((res) => {
        if (cancelled) return
        const data = res?.data?.data
        const items = Array.isArray(data) ? data : data?.items ?? []
        setUsers(Array.isArray(items) ? items : [])
      })
      .catch(() => {
        if (!cancelled) setUsers([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const reset = () => {
    setTitle('')
    setUrgency('MEDIUM')
    setProjectId(defaultProjectId ?? '')
    setDesc('')
    setAssigneeId('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) {
      toast({ title: '请填写问题标题', variant: 'destructive' })
      return
    }
    if (!projectId) {
      toast({ title: '请选择所属项目', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const res = await api.post('/issues', {
        title: title.trim(),
        urgency,
        projectId,
        desc: desc.trim() ? desc.trim() : undefined,
        assigneeId: assigneeId || undefined,
      })
      const data = res?.data?.data as IssueFormResult | undefined
      toast({ title: '问题上报成功', description: '已生成问题会话与处理任务' })
      reset()
      onSuccess?.(data as IssueFormResult)
    } catch (err) {
      const message = err instanceof Error ? err.message : '上报失败，请稍后重试'
      toast({ title: '上报失败', description: message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className={cn('grid gap-4', className)}>
      <div className="grid gap-2">
        <Label htmlFor="issue-title">问题标题</Label>
        <Input
          id="issue-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="一句话描述问题，如：现场阀门异常"
          maxLength={200}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>紧急度</Label>
          <Select value={urgency} onValueChange={(v) => setUrgency(v as Urgency)}>
            <SelectTrigger>
              <SelectValue placeholder="选择紧急度" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="HIGH">高</SelectItem>
              <SelectItem value="MEDIUM">中</SelectItem>
              <SelectItem value="LOW">低</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label>所属项目</Label>
          <Select value={projectId || undefined} onValueChange={setProjectId}>
            <SelectTrigger>
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.code ? (
                    <span className="ml-1 text-xs text-muted-foreground">· {p.code}</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="issue-desc">描述</Label>
        <Textarea
          id="issue-desc"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="问题详情、现场情况、影响范围等（可选）"
          rows={4}
        />
      </div>

      <div className="grid gap-2">
        <Label>指派给（可选）</Label>
        <Select
          value={assigneeId || undefined}
          onValueChange={(v) => setAssigneeId(v === '__none__' ? '' : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择处理人（不选则由项目负责人处理）" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">
              <span className="text-muted-foreground">（不指定）</span>
            </SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
                {u.email ? (
                  <span className="ml-1 text-xs text-muted-foreground">· {u.email}</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting} className={cn(submitting && 'opacity-80')}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          提交上报
        </Button>
      </div>
    </form>
  )
}
