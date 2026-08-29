'use client'

/**
 * 外部主体类型可见性配置（权限 V2.1 2026-08-21）
 *
 * 管理员对 5 种外部主体类型（客户/供应商/外协/承包商/其他）分别设置可见范围：
 *   - PUBLIC：全员可见
 *   - RESTRICTED：指定部门 + 额外用户可见
 * 供权限分配页（settings）与外部主体页（organization/externals）复用。
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Save } from 'lucide-react'
import { ApiService } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

const EXTERNAL_TYPE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  OUTSOURCER: '外协',
  CONTRACTOR: '承包商',
  OTHER: '其他',
}

interface ExternalScopeData {
  types: Array<{
    type: string
    visibility: string
    deptIds: string[]
    userIds: string[]
    configured: boolean
  }>
  departments: Array<{ id: string; name: string }>
  users: Array<{ id: string; name: string; username: string; departmentId: string | null }>
}

export function ExternalOrgScopeConfig() {
  const { toast } = useToast()
  const [saving, setSaving] = React.useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['external-org-scopes'],
    queryFn: () =>
      ApiService.get<ExternalScopeData>('/admin/external-org-scopes').then((r) => r.data),
  })

  // 本地编辑态：type → { visibility, deptIds, userIds }
  const [edits, setEdits] = React.useState<Record<string, { visibility: string; deptIds: string[]; userIds: string[] }>>({})

  React.useEffect(() => {
    if (data) {
      const init: Record<string, { visibility: string; deptIds: string[]; userIds: string[] }> = {}
      for (const t of data.types) {
        init[t.type] = { visibility: t.visibility, deptIds: t.deptIds, userIds: t.userIds }
      }
      setEdits(init)
    }
  }, [data])

  const toggleDept = (type: string, deptId: string) => {
    setEdits((prev) => {
      const cur = prev[type] ?? { visibility: 'RESTRICTED', deptIds: [], userIds: [] }
      const deptIds = cur.deptIds.includes(deptId)
        ? cur.deptIds.filter((x) => x !== deptId)
        : [...cur.deptIds, deptId]
      return { ...prev, [type]: { ...cur, deptIds } }
    })
  }

  const toggleUser = (type: string, userId: string) => {
    setEdits((prev) => {
      const cur = prev[type] ?? { visibility: 'RESTRICTED', deptIds: [], userIds: [] }
      const userIds = cur.userIds.includes(userId)
        ? cur.userIds.filter((x) => x !== userId)
        : [...cur.userIds, userId]
      return { ...prev, [type]: { ...cur, userIds } }
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const scopes = Object.entries(edits).map(([type, e]) => ({ type, ...e }))
      await ApiService.put('/admin/external-org-scopes', { scopes })
      toast({ description: '外部主体可见性已保存 ✓' })
      refetch()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">外部主体类型可见性</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按类型（客户/供应商/外协/承包商/其他）分别设置可见部门与用户；
            未配置的类型按默认规则（供应商=采购部，其余=成员项目关联）
          </p>
        </div>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          保存配置
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.types.map((t) => {
          const e = edits[t.type] ?? { visibility: 'RESTRICTED', deptIds: [], userIds: [] }
          const isPublic = e.visibility === 'PUBLIC'
          return (
            <div key={t.type} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">
                    {EXTERNAL_TYPE_LABEL[t.type] ?? t.type}
                  </span>
                  <span className="text-xs text-muted-foreground">{t.type}</span>
                </div>
                <div className="inline-flex rounded-md border border-input p-0.5">
                  {(
                    [
                      ['RESTRICTED', '指定部门/用户'],
                      ['PUBLIC', '全员可见'],
                    ] as const
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() =>
                        setEdits((prev) => ({
                          ...prev,
                          [t.type]: { ...e, visibility: v },
                        }))
                      }
                      className={cn(
                        'rounded px-2.5 py-1 text-xs transition-colors',
                        e.visibility === v
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {isPublic ? (
                <p className="text-xs text-muted-foreground">
                  🔓 该类型对全体员工可见
                </p>
              ) : (
                <div className="space-y-2">
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                      可见部门（勾选）：
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {data.departments.map((d) => {
                        const on = e.deptIds.includes(d.id)
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => toggleDept(t.type, d.id)}
                            className={cn(
                              'rounded-md border px-2 py-0.5 text-xs transition-colors',
                              on
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                            )}
                          >
                            {on && '✓ '}
                            {d.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                      额外可见用户（勾选，超出部门范围）：
                    </p>
                    <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                      {data.users.map((u) => {
                        const on = e.userIds.includes(u.id)
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => toggleUser(t.type, u.id)}
                            className={cn(
                              'rounded-md border px-2 py-0.5 text-xs transition-colors',
                              on
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border text-muted-foreground hover:border-muted-foreground/40',
                            )}
                          >
                            {on && '✓ '}
                            {u.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
