'use client'

/**
 * 人员选择弹窗（组织架构成员树选人）—— P0-7 / P0-8 共用
 *
 * 数据源：GET /api/departments（部门树内嵌在职成员），扁平化后展示「姓名 / 部门路径 / 岗位」。
 * 支持单选（single，用于单聊）与多选（multi，用于建群 / 批量加成员）。
 * confirmText 可为函数（按已选人数动态生成文案，如「发起单聊 / 发起群聊（N 人）」）。
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { ApiService } from '@/services/api'
import { ImAvatar } from '@/components/im/message-bubble'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface DeptMemberBrief {
  id: string
  name: string
  jobTitle: string | null
  avatar: string | null
}

interface DeptNode {
  id: string
  name: string
  parentId: string | null
  members: DeptMemberBrief[]
  children: DeptNode[]
}

export interface PickerMember {
  id: string
  name: string
  jobTitle: string | null
  avatar: string | null
  dept: string
}

interface MemberPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'single' | 'multi'
  title?: string
  description?: string
  confirmText?: string | ((count: number) => string)
  excludeIds?: string[]
  loading?: boolean
  onConfirm: (selected: PickerMember[]) => void
}

function flattenDept(tree: DeptNode[], path = ''): PickerMember[] {
  const out: PickerMember[] = []
  for (const node of tree) {
    const p = path ? `${path} / ${node.name}` : node.name
    for (const m of node.members) {
      out.push({ id: m.id, name: m.name, jobTitle: m.jobTitle, avatar: m.avatar, dept: p })
    }
    out.push(...flattenDept(node.children, p))
  }
  return out
}

export function MemberPicker({
  open,
  onOpenChange,
  mode = 'multi',
  title,
  description,
  confirmText,
  excludeIds,
  loading = false,
  onConfirm,
}: MemberPickerProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data } = useQuery({
    queryKey: ['departments-tree'],
    queryFn: async () => {
      const res = await ApiService.get<{ items: DeptNode[] }>('/departments')
      return res.data?.items ?? []
    },
    enabled: open,
  })

  const members = useMemo(() => {
    const all = flattenDept(data ?? [])
    const exclude = new Set(excludeIds ?? [])
    return all.filter((m) => !exclude.has(m.id))
  }, [data, excludeIds])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return members
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.jobTitle ?? '').toLowerCase().includes(q) ||
        m.dept.toLowerCase().includes(q),
    )
  }, [members, query])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (mode === 'single') {
        next.clear()
        next.add(id)
      } else if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const confirm = () => {
    const sel = members.filter((m) => selected.has(m.id))
    onConfirm(sel)
    setSelected(new Set())
    setQuery('')
  }

  const count = selected.size
  const label =
    typeof confirmText === 'function' ? confirmText(count) : confirmText ?? '确定'

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setSelected(new Set())
          setQuery('')
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? '选择成员'}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名 / 岗位 / 部门"
            className="pl-8"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
          {filtered.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">无匹配成员</p>
          )}
          {filtered.map((m) => {
            const checked = selected.has(m.id)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60',
                  checked && 'bg-muted',
                )}
              >
                {mode === 'multi' && (
                  <Checkbox checked={checked} className="pointer-events-none" />
                )}
                <ImAvatar name={m.name} className="h-8 w-8 text-[10px]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{m.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.dept}
                    {m.jobTitle ? ` · ${m.jobTitle}` : ''}
                  </div>
                </div>
                {mode === 'single' && checked && (
                  <span className="shrink-0 text-xs text-primary">已选</span>
                )}
              </button>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={count === 0 || loading} onClick={confirm}>
            {loading ? '处理中…' : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
