'use client'

/**
 * 创建采购订单弹窗（2026-08-22 采购模块 Step 3）
 *
 * 步骤式单弹窗：选项目 → 类别 → 供应商 → 明细行（可增删）→ 计划到货日期 → 备注
 * isSupplementary 模式：追加原因必填。
 * 提交 POST /api/purchase-orders（submit=true 直接 ORDERED / 否则 DRAFT）
 */

import * as React from 'react'
import * as XLSX from 'xlsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, FileSpreadsheet, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'

interface ProjectOption {
  id: string
  code: string
  name: string
}

interface SupplierOption {
  id: string
  name: string
}

interface ItemRow {
  name: string
  spec: string
  brand: string
  quantity: string
  unit: string
  unitPrice: string
  remark: string
}

const EMPTY_ROW: ItemRow = { name: '', spec: '', brand: '', quantity: '1', unit: '件', unitPrice: '', remark: '' }

const CATEGORY_LABEL: Record<string, string> = {
  MECHANICAL: '机械',
  ELECTRICAL: '电气',
  OTHER: '其他',
}

const REJECT_REASONS = ['现场缺件', '临时加急', '设计变更', '损耗补充']

/** 编辑模式的既有订单快照（DRAFT 编辑：title/category/supplier/明细/计划到货/备注） */
interface EditableOrder {
  id: string
  title: string
  category: 'MECHANICAL' | 'ELECTRICAL' | 'OTHER'
  supplierId: string | null
  plannedArrivalDate: string | null
  remark: string | null
  items: Array<{
    name: string
    spec: string | null
    brand: string | null
    quantity: number
    unit: string
    unitPrice: number | null
    remark: string | null
  }>
}

export interface OrderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 追加采购模式 */
  supplementary?: boolean
  /** 追加指向的原订单 */
  supplementaryOfId?: string | null
  /** 预选项目（从项目详情跳转等） */
  defaultProjectId?: string | null
  /** 关联的供应商需求（SR 转订单） */
  supplierRequestId?: string | null
  /** SR 模式下预填 */
  defaults?: Partial<{ projectId: string; supplierId: string; category: string; title: string }>
  /** 编辑模式：DRAFT 订单 id（设置后加载既有数据、PATCH 提交） */
  editOrderId?: string | null
  onCreated?: () => void
}

export function OrderFormDialog({
  open,
  onOpenChange,
  supplementary = false,
  supplementaryOfId = null,
  defaultProjectId = null,
  supplierRequestId = null,
  defaults,
  editOrderId = null,
  onCreated,
}: OrderFormDialogProps) {
  const isEdit = !!editOrderId
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)

  // 表单状态
  const [projectId, setProjectId] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [category, setCategory] = React.useState<'MECHANICAL' | 'ELECTRICAL' | 'OTHER'>('MECHANICAL')
  const [supplierId, setSupplierId] = React.useState<string>('')
  const [plannedArrivalDate, setPlannedArrivalDate] = React.useState('')
  const [remark, setRemark] = React.useState('')
  const [suppReason, setSuppReason] = React.useState('')
  const [suppReasonText, setSuppReasonText] = React.useState('')
  const [items, setItems] = React.useState<ItemRow[]>([{ ...EMPTY_ROW }])
  const [loadingEdit, setLoadingEdit] = React.useState(false)

  // ★ AI 分解清单（S4）：自由文本 → 结构化明细建议，填入明细行可编辑
  const [aiOpen, setAiOpen] = React.useState(false)
  const [aiText, setAiText] = React.useState('')
  const [aiBusy, setAiBusy] = React.useState(false)

  // ★ Excel 导入（xlsx 解析 → AI 智能列映射 → 填明细行）
  const [excelBusy, setExcelBusy] = React.useState(false)
  const excelInputRef = React.useRef<HTMLInputElement>(null)

  interface DecomposeExcelItem {
    name: string
    brand?: string
    supplierName?: string
    spec?: string
    param?: string
    quantity?: number
    unit?: string
    remark?: string
  }

  /** 供应商名称与系统供应商列表双向模糊匹配 */
  const matchSupplier = (name: string): SupplierOption | undefined =>
    suppliers.find((s) => (name && (s.name.includes(name) || name.includes(s.name))) || false)

  const onExcelFile = async (file: File) => {
    if (excelBusy) return
    setExcelBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) throw new Error('文件中没有工作表')
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][]
      let rows = raw
        .map((r) => r.map((c) => String(c ?? '').trim()))
        .filter((r) => r.some((c) => c !== '')) // 去全空行
      if (rows.length === 0) throw new Error('表格内容为空')
      if (rows.length > 200) {
        rows = rows.slice(0, 200)
        toast({ description: '表格超过 200 行，已截取前 200 行解析' })
      }
      const res = await ApiService.post<{
        items: DecomposeExcelItem[]
        uncertain: Array<{ row: number; reason: string }>
      }>(
        '/ai/decompose-purchase',
        { mode: 'excel', rows },
        { timeout: 120_000 },
      )
      const got = res.data?.items ?? []
      const uncertain = res.data?.uncertain ?? []
      if (got.length === 0) {
        toast({ variant: 'destructive', description: 'AI 未能从表格中识别出物料，请检查列内容或改用手填' })
        return
      }
      setItems((prev) => {
        const base = prev.length === 1 && !prev[0].name.trim() ? [] : prev
        return [
          ...base,
          ...got.map((g) => ({
            name: g.name,
            // DB 无 param 列（v3 设计）：参数并入规格型号列保留信息
            spec: [g.spec, g.param].filter(Boolean).join('；'),
            brand: g.brand ?? '',
            quantity: String(g.quantity ?? 1),
            unit: g.unit || '件',
            unitPrice: '',
            remark: g.remark ?? '',
          })),
        ]
      })
      // 供应商匹配：取出现频次最高的供应商名尝试选中；未匹配的行提示
      const names = got.map((g) => (g.supplierName ?? '').trim()).filter(Boolean)
      if (names.length > 0) {
        const freq = new Map<string, number>()
        names.forEach((n) => freq.set(n, (freq.get(n) ?? 0) + 1))
        const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).map(([n]) => n)
        const hit = matchSupplier(top[0])
        if (hit && !supplierId) {
          setSupplierId(hit.id)
          toast({ description: `AI 已填入 ${got.length} 行明细，供应商已匹配：${hit.name}` })
        } else {
          const unmatched = top.filter((n) => !matchSupplier(n))
          toast({
            description:
              `AI 已填入 ${got.length} 行明细` +
              (unmatched.length
                ? `；${unmatched.length} 家供应商未匹配到系统（${unmatched.slice(0, 3).join('、')}），请手动选择`
                : ''),
          })
        }
      } else {
        toast({ description: `AI 已填入 ${got.length} 行明细，请核对单价` })
      }
      if (uncertain.length > 0) {
        toast({
          description: `另有 ${uncertain.length} 行未能识别（如合计/空行），已跳过`,
        })
      }
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : 'Excel 导入失败' })
    } finally {
      setExcelBusy(false)
      if (excelInputRef.current) excelInputRef.current.value = ''
    }
  }

  /** 动态生成导入模板 xlsx（前端生成，零后端依赖） */
  const downloadTemplate = () => {
    const aoa = [
      ['品名', '品牌', '供应商', '规格型号', '参数', '数量', '单位', '备注'],
      ['不锈钢球阀', '盾安', '上海盾安阀门', 'DN50', 'PN16', '5', '个', '首批到货'],
      ['三相异步电机', '西门子', '', 'Y2-132M-4', '380V 7.5kW IP55', '2', '台', ''],
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 6 }, { wch: 6 }, { wch: 12 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '采购清单')
    XLSX.writeFile(wb, '采购清单导入模板.xlsx')
  }

  const runDecompose = async () => {
    if (!aiText.trim() || aiBusy) return
    setAiBusy(true)
    try {
      const res = await ApiService.post<{ items: Array<{ name: string; spec: string; quantity: number; unit: string }> }>(
        '/ai/decompose-purchase',
        { text: aiText.trim() },
        { timeout: 120_000 },
      )
      const got = res.data?.items ?? []
      if (got.length === 0) {
        toast({ variant: 'destructive', description: 'AI 未能从描述中识别出物料，请换种写法' })
        return
      }
      setItems((rows) => {
        // 首行是空行则替换，其余追加；单价留空由用户填
        const base = rows.length === 1 && !rows[0].name.trim() ? [] : rows
        return [
          ...base,
          ...got.map((g) => ({
            name: g.name,
            spec: g.spec ?? '',
            brand: '',
            quantity: String(g.quantity ?? 1),
            unit: g.unit || '件',
            unitPrice: '',
            remark: '',
          })),
        ]
      })
      setAiOpen(false)
      setAiText('')
      toast({ description: `AI 已填入 ${got.length} 行明细，请核对后补充品牌/单价` })
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : 'AI 分解失败' })
    } finally {
      setAiBusy(false)
    }
  }

  // 打开时重置/预填
  React.useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? defaults?.projectId ?? '')
      setTitle(defaults?.title ?? '')
      setCategory(((defaults?.category as typeof category) ?? 'MECHANICAL') as typeof category)
      setSupplierId(defaults?.supplierId ?? '')
      setPlannedArrivalDate('')
      setRemark('')
      setSuppReason('')
      setSuppReasonText('')
      setItems([{ ...EMPTY_ROW }])
    }
  }, [open, defaultProjectId, defaults])

  // ★ 编辑模式：加载既有 DRAFT 订单数据
  React.useEffect(() => {
    if (!open || !editOrderId) return
    setLoadingEdit(true)
    ApiService.get<EditableOrder>(`/purchase-orders/${editOrderId}`)
      .then((r) => r.data)
      .then((o?: EditableOrder) => {
        if (!o) return
        setTitle(o.title)
        setCategory(o.category)
        setSupplierId(o.supplierId ?? '')
        setPlannedArrivalDate(
          o.plannedArrivalDate ? new Date(o.plannedArrivalDate).toISOString().slice(0, 10) : '',
        )
        setRemark(o.remark ?? '')
        setItems(
          o.items.length > 0
            ? o.items.map((it) => ({
                name: it.name,
                spec: it.spec ?? '',
                brand: it.brand ?? '',
                quantity: String(it.quantity),
                unit: it.unit,
                unitPrice: it.unitPrice != null ? String(it.unitPrice) : '',
                remark: it.remark ?? '',
              }))
            : [{ ...EMPTY_ROW }],
        )
      })
      .catch((e) =>
        toast({
          variant: 'destructive',
          description: e instanceof Error ? e.message : '加载订单失败',
        }),
      )
      .finally(() => setLoadingEdit(false))
  }, [open, editOrderId])

  // 项目列表（可见项目）
  const { data: projects = [] } = useQuery({
    queryKey: ['purchase-form-projects'],
    queryFn: () =>
      ApiService.get<{ items: ProjectOption[] }>('/projects?limit=100').then(
        (r) => r.data?.items ?? [],
      ),
    enabled: open,
  })

  // 供应商列表（ExternalOrg type=SUPPLIER）
  const { data: suppliers = [] } = useQuery({
    queryKey: ['purchase-form-suppliers'],
    queryFn: () =>
      ApiService.get<{ items: SupplierOption[] }>('/external-orgs?type=SUPPLIER&limit=200').then(
        (r) => ((r.data as any)?.items ?? (r.data as any) ?? []) as SupplierOption[],
      ),
    enabled: open,
  })

  const setRow = (idx: number, patch: Partial<ItemRow>) => {
    setItems((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addRow = () => setItems((rows) => [...rows, { ...EMPTY_ROW }])
  const removeRow = (idx: number) =>
    setItems((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows))

  const validate = (): string | null => {
    if (!isEdit && !projectId) return '请选择项目'
    if (!title.trim()) return '请填写订单标题'
    // ★ 编辑模式允许暂不绑供应商（DRAFT 可后补）；创建必选
    if (!isEdit && !supplementary && !supplierId) return '请选择供应商'
    if (!isEdit && supplementary && !suppReason) return '请选择追加原因'
    for (let i = 0; i < items.length; i++) {
      if (!items[i].name.trim()) return `第 ${i + 1} 行物料名称不能为空`
      const q = Number(items[i].quantity)
      if (!q || q <= 0 || Number.isNaN(q)) return `第 ${i + 1} 行数量必须大于 0`
      if (items[i].unitPrice && (Number.isNaN(Number(items[i].unitPrice)) || Number(items[i].unitPrice) < 0))
        return `第 ${i + 1} 行单价不合法`
    }
    return null
  }

  const submit = async () => {
    const err = validate()
    if (err) {
      toast({ variant: 'destructive', description: err })
      return
    }
    setSaving(true)
    try {
      if (isEdit && editOrderId) {
        // ★ 编辑模式：PATCH 全量替换明细 + 头字段（仅 DRAFT 可改，后端校验）
        await ApiService.patch(`/purchase-orders/${editOrderId}`, {
          title: title.trim(),
          category,
          supplierId: supplierId || null,
          ...(plannedArrivalDate && {
            plannedArrivalDate: new Date(plannedArrivalDate).toISOString(),
          }),
          remark: remark.trim() || null,
          items: items.map((r) => ({
            name: r.name.trim(),
            spec: r.spec.trim() || null,
            brand: r.brand.trim() || null,
            quantity: Number(r.quantity),
            unit: r.unit.trim() || '件',
            unitPrice: r.unitPrice ? Number(r.unitPrice) : null,
            remark: r.remark.trim() || null,
          })),
        })
        toast({ description: '订单已更新 ✓' })
      } else {
      await ApiService.post('/purchase-orders', {
        projectId,
        title: title.trim(),
        category,
        ...(supplementary ? {} : { supplierId }),
        items: items.map((r) => ({
          name: r.name.trim(),
          spec: r.spec.trim() || null,
          brand: r.brand.trim() || null,
          quantity: Number(r.quantity),
          unit: r.unit.trim() || '件',
          unitPrice: r.unitPrice ? Number(r.unitPrice) : null,
          remark: r.remark.trim() || null,
        })),
        isSupplementary: supplementary,
        ...(supplementary && {
          supplementaryReason: suppReasonText.trim()
            ? `${suppReason}${suppReasonText.trim() ? '：' + suppReasonText.trim() : ''}`
            : suppReason,
          supplementaryOfId,
        }),
        supplierRequestId,
        ...(plannedArrivalDate && {
          plannedArrivalDate: new Date(plannedArrivalDate).toISOString(),
        }),
        remark: remark.trim() || null,
      })
      // V3：订单一律 DRAFT 起步，正式下单需在详情中走「发起合同→确认→下单」流程
      toast({ description: '草稿已保存 ✓（正式下单请在详情中推进合同流程）' })
      }
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-summary'] })
      onOpenChange(false)
      onCreated?.()
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? '编辑采购订单（草稿）' : supplementary ? '追加采购' : '新建采购订单'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? '仅草稿状态可编辑：修改后全量替换明细，金额自动重算'
              : supplementary
                ? '现场缺件/临时加急等情况下的追加下单，需填写追加原因'
                : '一次向某供应商的下单，可含多行明细；保存草稿后在详情中推进合同流程下单'}
          </DialogDescription>
        </DialogHeader>
        {loadingEdit ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
        <div className="space-y-4">
          {/* 项目（编辑模式不可改项目） */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>项目{isEdit ? '' : ' *'}</Label>
              {isEdit ? (
                <div className="flex h-9 items-center rounded-md border px-3 text-sm text-muted-foreground">
                  已锁定（编辑不改变所属项目）
                </div>
              ) : (
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
              )}
            </div>
            <div className="space-y-1.5">
              <Label>订单标题 *</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={supplementary ? '如「现场缺件加急采购」' : '如「电气元件第一批」'}
              />
            </div>
          </div>

          {/* 类别 */}
          <div className="space-y-1.5">
            <Label>采购类别</Label>
            <div className="inline-flex rounded-md border border-input p-0.5">
              {(Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c as typeof category)}
                  className={cn(
                    'rounded px-3 py-1.5 text-xs transition-colors',
                    category === c
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          {/* 供应商（编辑模式可暂不绑定） */}
          {!supplementary && (
            <div className="space-y-1.5">
              <Label>供应商{isEdit ? '' : ' *'}</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择供应商" />
                </SelectTrigger>
                <SelectContent>
                  {isEdit && <SelectItem value="">暂不绑定（后补）</SelectItem>}
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 追加原因 */}
          {supplementary && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>追加原因 *</Label>
                <Select value={suppReason} onValueChange={setSuppReason}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择原因" />
                  </SelectTrigger>
                  <SelectContent>
                    {REJECT_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>补充说明</Label>
                <Input
                  value={suppReasonText}
                  onChange={(e) => setSuppReasonText(e.target.value)}
                  placeholder='可选'
                />
              </div>
            </div>
          )}

          {/* 明细行 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>订单明细 *（至少一条）</Label>
              <div className="flex items-center gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setAiOpen(true)}>
                  <Sparkles className="mr-1 h-3.5 w-3.5 text-primary" /> AI 分解清单
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={excelBusy}
                  onClick={() => excelInputRef.current?.click()}
                >
                  {excelBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="mr-1 h-3.5 w-3.5 text-emerald-600" />
                  )}
                  {excelBusy ? 'AI 解析中…' : 'Excel 导入'}
                </Button>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  <FileDown className="h-3 w-3" /> 模板
                </button>
                <input
                  ref={excelInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void onExcelFile(f)
                  }}
                />
                <Button type="button" size="sm" variant="outline" onClick={addRow}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> 加一行
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">物料名称 *</th>
                    <th className="px-2 py-1.5 font-medium">规格型号</th>
                    <th className="px-2 py-1.5 font-medium">品牌</th>
                    <th className="w-20 px-2 py-1.5 font-medium">数量 *</th>
                    <th className="w-16 px-2 py-1.5 font-medium">单位</th>
                    <th className="w-24 px-2 py-1.5 font-medium">单价(元)</th>
                    <th className="w-28 px-2 py-1.5 font-medium">备注</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.name}
                          onChange={(e) => setRow(idx, { name: e.target.value })}
                          placeholder="如 不锈钢球阀"
                        />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.spec}
                          onChange={(e) => setRow(idx, { spec: e.target.value })}
                          placeholder="DN50/PN16"
                        />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.brand}
                          onChange={(e) => setRow(idx, { brand: e.target.value })}
                        />
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
                          value={row.unit}
                          onChange={(e) => setRow(idx, { unit: e.target.value })}
                        />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          type="number"
                          min="0"
                          step="any"
                          value={row.unitPrice}
                          onChange={(e) => setRow(idx, { unitPrice: e.target.value })}
                        />
                      </td>
                      <td className="px-1.5 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.remark}
                          onChange={(e) => setRow(idx, { remark: e.target.value })}
                        />
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeRow(idx)}
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

          {/* 计划到货 + 备注 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>计划到货日期</Label>
              <Input
                type="date"
                value={plannedArrivalDate}
                onChange={(e) => setPlannedArrivalDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>备注</Label>
              <Textarea
                className="h-9 min-h-9 rows-1"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
          </div>
        </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          {isEdit ? (
            <Button onClick={() => submit()} disabled={saving || loadingEdit}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              保存修改
            </Button>
          ) : (
            <Button onClick={() => submit()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              存草稿
            </Button>
          )}
        </DialogFooter>

        {/* AI 分解清单弹窗 */}
        <Dialog open={aiOpen} onOpenChange={setAiOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" /> AI 分解采购清单
              </DialogTitle>
              <DialogDescription>
                用一句话描述采购需求，AI 拆解成结构化明细行填入下方表格（品牌/单价自行补充）
              </DialogDescription>
            </DialogHeader>
            <Textarea
              rows={4}
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              placeholder={'如：2台三相异步电机380V 5.5kW，3米电缆4平方，DN50球阀5个'}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setAiOpen(false)} disabled={aiBusy}>
                取消
              </Button>
              <Button onClick={() => runDecompose()} disabled={aiBusy || aiText.trim().length < 2}>
                {aiBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                {aiBusy ? 'AI 解析中…' : '开始分解'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
