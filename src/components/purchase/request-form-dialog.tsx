'use client'

/**
 * 采购清单（提需求）弹窗（2026-08-22 采购模块 Step 3）
 *
 * 任何项目成员可发起：选项目 → 标题/用途/类别/紧急度/期望到货 → 明细行（名称/规格/数量/品牌/期望价）
 * 提交 POST /api/purchase-requests（submit=true 直接 SUBMITTED / 否则 DRAFT）
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'

interface ProjectOption {
  id: string
  code: string
  name: string
}

interface ItemRow {
  name: string
  spec: string
  brand: string
  quantity: string
  unit: string
  targetPrice: string
}

const EMPTY_ROW: ItemRow = { name: '', spec: '', brand: '', quantity: '1', unit: '件', targetPrice: '' }

const PRIORITY_LABEL: Record<string, string> = {
  LOW: '不急',
  NORMAL: '常规',
  URGENT: '紧急',
}

export interface RequestFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultProjectId?: string | null
  onCreated?: () => void
}

export function RequestFormDialog({ open, onOpenChange, defaultProjectId = null, onCreated }: RequestFormDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  const [projectId, setProjectId] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [purpose, setPurpose] = React.useState('')
  const [priority, setPriority] = React.useState<'LOW' | 'NORMAL' | 'URGENT'>('NORMAL')
  const [expectedArrivalDate, setExpectedArrivalDate] = React.useState('')
  const [remark, setRemark] = React.useState('')
  const [items, setItems] = React.useState<ItemRow[]>([{ ...EMPTY_ROW }])

  React.useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? '')
      setTitle('')
      setPurpose('')
      setPriority('NORMAL')
      setExpectedArrivalDate('')
      setRemark('')
      setItems([{ ...EMPTY_ROW }])
    }
  }, [open, defaultProjectId])

  const { data: projects = [] } = useQuery({
    queryKey: ['purchase-form-projects'],
    queryFn: () =>
      ApiService.get<{ items: ProjectOption[] }>('/projects?limit=100').then(
        (r) => r.data?.items ?? [],
      ),
    enabled: open,
  })

  const setRow = (idx: number, patch: Partial<ItemRow>) =>
    setItems((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  const validate = (): string | null => {
    if (!projectId) return '请选择项目'
    if (!title.trim()) return '请填写清单标题'
    for (let i = 0; i < items.length; i++) {
      if (!items[i].name.trim()) return `第 ${i + 1} 行物料名称不能为空`
      const q = Number(items[i].quantity)
      if (!q || q <= 0 || Number.isNaN(q)) return `第 ${i + 1} 行数量必须大于 0`
    }
    return null
  }

  const submit = async (directSubmit: boolean) => {
    const err = validate()
    if (err) {
      toast({ variant: 'destructive', description: err })
      return
    }
    setSaving(true)
    try {
      await ApiService.post('/purchase-requests', {
        projectId,
        title: title.trim(),
        purpose: purpose.trim() || null,
        priority,
        ...(expectedArrivalDate && {
          expectedArrivalDate: new Date(expectedArrivalDate).toISOString(),
        }),
        remark: remark.trim() || null,
        items: items.map((r) => ({
          name: r.name.trim(),
          spec: r.spec.trim() || null,
          brand: r.brand.trim() || null,
          quantity: Number(r.quantity),
          unit: r.unit.trim() || '件',
          targetPrice: r.targetPrice ? Number(r.targetPrice) : null,
        })),
        submit: directSubmit,
      })
      toast({
        description: directSubmit ? '清单已提交，等待采购部处理 ✓' : '草稿已保存 ✓',
      })
      queryClient.invalidateQueries({ queryKey: ['purchase-requests'] })
      onOpenChange(false)
      onCreated?.()
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : '提交失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>提采购需求</DialogTitle>
          <DialogDescription>根据工作需要填写采购清单，提交后由采购部统一处理</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>项目 *</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>标题 *</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如「现场仪表补充采购」" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>紧急程度</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>期望到货日期</Label>
              <Input
                type="date"
                value={expectedArrivalDate}
                onChange={(e) => setExpectedArrivalDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>用途说明</Label>
            <Textarea
              className="min-h-16"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="如：三楼仪表接线需要，缺以下元件"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>物料明细 *（至少一条）</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setItems((rows) => [...rows, { ...EMPTY_ROW }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> 加一行
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">物料名称 *</th>
                    <th className="px-2 py-1.5 font-medium">规格</th>
                    <th className="px-2 py-1.5 font-medium">品牌</th>
                    <th className="w-20 px-2 py-1.5 font-medium">数量 *</th>
                    <th className="w-24 px-2 py-1.5 font-medium">期望价(元)</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="px-1.5 py-1">
                        <Input className="h-7 text-xs" value={row.name} onChange={(e) => setRow(idx, { name: e.target.value })} />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input className="h-7 text-xs" value={row.spec} onChange={(e) => setRow(idx, { spec: e.target.value })} />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input className="h-7 text-xs" value={row.brand} onChange={(e) => setRow(idx, { brand: e.target.value })} />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          type="number"
                          min="0"
                          step="any"
                          value={row.quantity}
                          onChange={(e) => setRow(idx, { quantity: e.target.value })}
                        />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          type="number"
                          min="0"
                          step="any"
                          value={row.targetPrice}
                          onChange={(e) => setRow(idx, { targetPrice: e.target.value })}
                        />
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setItems((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows))
                          }
                          disabled={items.length <= 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>备注</Label>
            <Textarea className="min-h-12" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            存草稿
          </Button>
          <Button onClick={() => submit(true)} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            提交给采购
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
