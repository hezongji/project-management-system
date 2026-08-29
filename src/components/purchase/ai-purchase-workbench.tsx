'use client'

/**
 * AI 采购工作台（★ 2026-08-25 采购模块重构核心 UI）
 *
 * 用户流程：工程师乱格式 Excel → AI 读懂并转成标准表格（序号/名称/型号/参数/单位/数量/品牌/备注）
 *          → 采购员核对/编辑 → AI 已按品牌归纳 → 每个品牌指定供应商（可调整）
 *          → 按供应商把材料归纳到一起 → 一键生成采购订单（一个供应商一张外发订单）
 *
 * 后端：POST /api/ai/decompose-purchase（乱表→标准行）+ POST /api/purchase-requests/ai-import（归单落库）
 */

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiService } from '@/services/api'
import { useToast } from '@/components/ui/use-toast'
import { downloadPurchaseTemplate } from '@/lib/excel-templates'
import {
  Sparkles,
  Upload,
  Loader2,
  Plus,
  Trash2,
  ArrowRight,
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ShoppingCart,
} from 'lucide-react'

/** 工作台标准行（序号为展示序号，不入库） */
interface WbRow {
  name: string
  spec: string // 型号
  param: string // 参数
  unit: string
  quantity: string
  brand: string
  unitPrice: string // 单价（元）（★ 2026-08-25 补：Excel 单价列直接填充，供成本核算）
  remark: string
}

interface AiParsedItem {
  name: string
  brand?: string
  supplierName?: string
  spec?: string
  param?: string
  quantity?: number
  unit?: string
  price?: number | null
  remark?: string
}

interface SupplierOpt {
  id: string
  name: string
}

const GENERIC_BRANDS = new Set(['电气供应商', '本地', '国标', '定制', '自制', '无', '不限'])
const normBrand = (b: string) => {
  const t = (b ?? '').trim()
  return !t || GENERIC_BRANDS.has(t) ? '待分配' : t
}

const EMPTY_ROW: WbRow = { name: '', spec: '', param: '', unit: '件', quantity: '1', brand: '', unitPrice: '', remark: '' }

export interface AiWorkbenchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  projectName?: string
  onImported?: () => void
  /** 生成订单后跳转查看 */
  onViewOrder?: (orderId: string) => void
}

type Step = 'upload' | 'edit' | 'assign' | 'result'

interface ImportResult {
  request: { id: string; code: string; itemCount: number }
  orders: Array<{ id: string; code: string; supplierName: string; itemCount: number; brands: string[] }>
  pendingSrs: Array<{ id: string; code: string; brand: string; itemCount: number }>
}

export function AiPurchaseWorkbench({ open, onOpenChange, projectId, projectName, onImported, onViewOrder }: AiWorkbenchProps) {
  const { toast } = useToast()
  const [step, setStep] = React.useState<Step>('upload')
  const [rows, setRows] = React.useState<WbRow[]>([])
  const [uncertain, setUncertain] = React.useState<Array<{ row: number; reason: string }>>([])
  const [warnings, setWarnings] = React.useState<string[]>([])
  const [parsing, setParsing] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<ImportResult | null>(null)
  // 品牌 → 供应商（'' = 暂不指定）
  const [brandSupplier, setBrandSupplier] = React.useState<Record<string, string>>({})
  const [selectedProjectId, setSelectedProjectId] = React.useState(projectId ?? '')
  const fileRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) {
      setStep('upload')
      setRows([])
      setUncertain([])
      setWarnings([])
      setResult(null)
      setBrandSupplier({})
      setSelectedProjectId(projectId ?? '')
    }
  }, [open, projectId])

  // 项目列表（未预指定项目时）
  const { data: projects = [] } = useQuery({
    queryKey: ['wb-projects'],
    queryFn: () =>
      ApiService.get<{ items: Array<{ id: string; code: string; name: string }> }>('/projects?limit=100')
        .then((r) => r.data?.items ?? []),
    enabled: open && !projectId,
  })
  // 供应商档案
  const { data: suppliers = [] } = useQuery({
    queryKey: ['wb-suppliers'],
    queryFn: () =>
      ApiService.get<{ items: SupplierOpt[] }>('/external-orgs?type=SUPPLIER&limit=200')
        .then((r) => ((r.data as unknown as { items?: SupplierOpt[] })?.items ?? (r.data as unknown as SupplierOpt[]) ?? [])),
    enabled: open,
  })

  const matchSupplierByName = (name: string): SupplierOpt | undefined => {
    const n = (name ?? '').trim()
    if (!n) return undefined
    return suppliers.find((s) => s.name.includes(n) || n.includes(s.name))
  }

  // ── 上传解析：XLSX → 原始矩阵 → AI 标准化 ──
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!selectedProjectId) {
      toast({ variant: 'destructive', description: '请先选择项目' })
      return
    }
    setParsing(true)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) throw new Error('文件中没有工作表')
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' }) as unknown as (string | number)[][]
      const matrix = aoa
        .map((r) => r.map((c) => String(c ?? '').trim()))
        .filter((r) => r.some((c) => c !== ''))
      if (matrix.length === 0) throw new Error('表格内容为空')
      // ★ 2026-08-25 夜间：上限 200→400（后端标准表头已改确定性直读，无 AI 成本；乱表 AI 兜底仍限 200）
      if (matrix.length > 400) matrix.splice(400)

      const res = await ApiService.post<{
        items: AiParsedItem[]
        uncertain: Array<{ row: number; reason: string }>
        warnings?: string[]
      }>(
        '/ai/decompose-purchase',
        { mode: 'excel', rows: matrix },
        { timeout: 290_000 },
      )
      const items = res.data?.items ?? []
      if (items.length === 0) {
        toast({ variant: 'destructive', description: res.message || 'AI 未能识别出物料，请检查表格内容' })
        return
      }
      const parsed: WbRow[] = items.map((it) => ({
        name: it.name ?? '',
        spec: it.spec ?? '',
        param: it.param ?? '',
        unit: it.unit || '件',
        quantity: String(it.quantity ?? 1),
        brand: it.brand ?? '',
        unitPrice: it.price != null ? String(it.price) : '',
        remark: it.remark ?? '',
      }))
      setRows(parsed)
      const uncertainRows = res.data?.uncertain ?? []
      setUncertain(uncertainRows)
      const parseWarnings = res.data?.warnings ?? []
      setWarnings(parseWarnings)
      // AI 供应商建议 → 预填品牌→供应商
      const suggest: Record<string, string> = {}
      items.forEach((it, i) => {
        const b = normBrand(parsed[i]?.brand ?? it.brand ?? '')
        if (!suggest[b]) {
          const hint = it.supplierName || (b !== '待分配' ? b : '')
          const hit = hint ? matchSupplierByName(hint) : undefined
          if (hit) suggest[b] = hit.id
        }
      })
      setBrandSupplier(suggest)
      setStep('edit')
      toast({
        description:
          `AI 已识别 ${items.length} 行` +
          (uncertainRows.length ? `，${uncertainRows.length} 行待人工确认` : '') +
          (parseWarnings.length ? `；${parseWarnings.length} 个分段解析失败，请核对明细是否有缺漏` : '') +
          '，请核对明细',
      })
    } catch (err) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (err as Error).message
      toast({ variant: 'destructive', description: msg || '解析失败' })
    } finally {
      setParsing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const setRow = (idx: number, patch: Partial<WbRow>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  // ── 品牌分组（编辑步之后实时计算）──
  const brandGroups = React.useMemo(() => {
    const map = new Map<string, { rows: number; qty: number }>()
    rows.forEach((r) => {
      const b = normBrand(r.brand)
      const g = map.get(b) ?? { rows: 0, qty: 0 }
      g.rows += 1
      g.qty += Number(r.quantity) || 0
      map.set(b, g)
    })
    return Array.from(map.entries()).map(([brand, g]) => ({ brand, ...g }))
  }, [rows])

  // ── 按供应商归纳（预览 + 提交）──
  const supplierGroups = React.useMemo(() => {
    const map = new Map<
      string,
      { supplierId: string; supplierName: string; brands: string[]; itemCount: number; qty: number }
    >()
    brandGroups.forEach(({ brand, rows: rc, qty }) => {
      const sid = brandSupplier[brand]
      if (!sid) return
      const sup = suppliers.find((s) => s.id === sid)
      const g = map.get(sid) ?? {
        supplierId: sid,
        supplierName: sup?.name ?? sid,
        brands: [],
        itemCount: 0,
        qty: 0,
      }
      g.brands.push(brand)
      g.itemCount += rc
      g.qty += qty
      map.set(sid, g)
    })
    return Array.from(map.values())
  }, [brandGroups, brandSupplier, suppliers])

  const unassignedBrands = brandGroups.filter((g) => !brandSupplier[g.brand])

  const validateRows = (): string | null => {
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]!.name.trim()) return `第 ${i + 1} 行名称不能为空`
      const q = Number(rows[i]!.quantity)
      if (!Number.isFinite(q) || q <= 0) return `第 ${i + 1} 行数量必须大于 0`
    }
    return null
  }

  const submit = async () => {
    const err = validateRows()
    if (err) {
      toast({ variant: 'destructive', description: err })
      return
    }
    if (!selectedProjectId) {
      toast({ variant: 'destructive', description: '请先选择项目' })
      return
    }
    setSubmitting(true)
    try {
      const res = await ApiService.post<ImportResult>(
        '/purchase-requests/ai-import',
        {
          projectId: selectedProjectId,
          rows: rows.map((r) => ({
            name: r.name.trim(),
            spec: r.spec.trim() || null,
            param: r.param.trim() || null,
            unit: r.unit.trim() || '件',
            quantity: Number(r.quantity),
            brand: r.brand.trim() || null,
            remark: r.remark.trim() || null,
            unitPrice: r.unitPrice && Number(r.unitPrice) >= 0 ? Number(r.unitPrice) : null,
            supplierId: brandSupplier[normBrand(r.brand)] || null,
          })),
        },
        { timeout: 120_000 },
      )
      setResult(res.data as ImportResult)
      setStep('result')
      toast({ description: res.message ?? '导入成功' })
      onImported?.()
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (e as Error).message
      toast({ title: '导入失败', description: msg, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const stepTitles: Array<{ key: Step; label: string }> = [
    { key: 'upload', label: '上传清单' },
    { key: 'edit', label: '核对明细' },
    { key: 'assign', label: '指定供应商' },
    { key: 'result', label: '完成' },
  ]
  const stepIdx = stepTitles.findIndex((s) => s.key === step)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> AI 采购工作台
          </DialogTitle>
          <DialogDescription>
            乱格式清单智能解析为标准采购表格，按品牌归纳，指定供应商后一键归单生成订单
            {projectName ? `（项目：${projectName}）` : ''}
          </DialogDescription>
        </DialogHeader>

        {/* 步骤条 */}
        <div className="flex items-center gap-1 text-xs">
          {stepTitles.map((s, i) => (
            <React.Fragment key={s.key}>
              {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
              <span
                className={
                  i === stepIdx
                    ? 'rounded bg-primary px-2 py-0.5 font-medium text-primary-foreground'
                    : i < stepIdx
                      ? 'text-emerald-600'
                      : 'text-muted-foreground'
                }
              >
                {i + 1}. {s.label}
              </span>
            </React.Fragment>
          ))}
        </div>

        {/* ── Step 1: 上传 ── */}
        {step === 'upload' && (
          <div className="space-y-3 py-2">
            {!projectId && (
              <div className="space-y-1">
                <Label className="text-xs">选择项目 *</Label>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">请选择项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center">
              {parsing ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">AI 正在读懂清单并转换为标准表格…</p>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    上传工程师发来的采购清单（格式不限：列名任意中文、列序不限、数量带单位均可）
                  </p>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!selectedProjectId) {
                        toast({ variant: 'destructive', description: '请先选择项目' })
                        return
                      }
                      fileRef.current?.click()
                    }}
                  >
                    <FileSpreadsheet className="mr-1 h-4 w-4" /> 选择 Excel 文件
                  </Button>
                  <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
                </>
              )}
            </div>
            <p className="text-center text-[11px] text-muted-foreground">
              AI 将输出标准字段：序号 / 名称 / 型号 / 参数 / 单位 / 数量 / 品牌 / 单价 / 备注，并自动按品牌归纳；
              未填品牌的材料归入「待分配」组
            </p>
            <div className="text-center">
              <Button variant="ghost" size="sm" onClick={() => downloadPurchaseTemplate()}>
                <FileSpreadsheet className="mr-1 h-4 w-4" /> 下载标准模板（发给工程师参考）
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: 核对明细（标准表格，全部可编辑）── */}
        {step === 'edit' && (
          <div className="space-y-3 py-2">
            {warnings.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                以下分段未能解析（已展示其余可识别行）：{warnings.slice(0, 3).join('；')}
                {warnings.length > 3 ? '…' : ''}
              </p>
            )}
            {uncertain.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                AI 跳过了 {uncertain.length} 个无法识别的行（
                {uncertain.slice(0, 6).map((u) => `第${u.row}行:${u.reason}`).join('；')}
                {uncertain.length > 6 ? '…' : ''}）；如属有效材料请点「加一行」手动补录
              </p>
            )}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground">
                  <tr>
                    <th className="w-10 px-2 py-1.5 font-medium">序号</th>
                    <th className="px-2 py-1.5 font-medium">名称 *</th>
                    <th className="px-2 py-1.5 font-medium">型号</th>
                    <th className="px-2 py-1.5 font-medium">参数</th>
                    <th className="w-16 px-2 py-1.5 font-medium">单位</th>
                    <th className="w-16 px-2 py-1.5 font-medium">数量 *</th>
                    <th className="px-2 py-1.5 font-medium">品牌</th>
                    <th className="w-20 px-2 py-1.5 font-medium">单价(元)</th>
                    <th className="px-2 py-1.5 font-medium">备注</th>
                    <th className="w-8 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="px-2 py-1 text-center text-muted-foreground">{idx + 1}</td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.name} onChange={(e) => setRow(idx, { name: e.target.value })} />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.spec} onChange={(e) => setRow(idx, { spec: e.target.value })} />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.param} onChange={(e) => setRow(idx, { param: e.target.value })} />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.unit} onChange={(e) => setRow(idx, { unit: e.target.value })} />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" type="number" min="0" step="any" value={r.quantity} onChange={(e) => setRow(idx, { quantity: e.target.value })} />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.brand} onChange={(e) => setRow(idx, { brand: e.target.value })} placeholder="留空归待分配" />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          className="h-7 text-xs"
                          type="number"
                          min="0"
                          step="any"
                          value={r.unitPrice}
                          onChange={(e) => setRow(idx, { unitPrice: e.target.value })}
                          placeholder="可空"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input className="h-7 text-xs" value={r.remark} onChange={(e) => setRow(idx, { remark: e.target.value })} />
                      </td>
                      <td className="px-1 py-1 text-center">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                          disabled={rows.length <= 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button type="button" size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, { ...EMPTY_ROW }])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 加一行
              </Button>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStep('upload')}>
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" /> 重新上传
                </Button>
                <Button size="sm" onClick={() => setStep('assign')}>
                  下一步：按品牌归纳 <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              共 {rows.length} 行 · {brandGroups.length} 个品牌组（{brandGroups.map((g) => g.brand).join('、')}）
            </p>
          </div>
        )}

        {/* ── Step 3: 按品牌指定供应商 + 按供应商归纳预览 ── */}
        {step === 'assign' && (
          <div className="space-y-4 py-2">
            <div>
              <p className="mb-2 text-xs font-medium">① AI 已按品牌归纳（{brandGroups.length} 组）——为每个品牌指定供货供应商：</p>
              <div className="grid gap-2 md:grid-cols-2">
                {brandGroups.map((g) => (
                  <div key={g.brand} className="flex items-center gap-2 rounded-md border p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{g.brand}</p>
                      <p className="text-[11px] text-muted-foreground">{g.rows} 行 · 共 {g.qty} 件</p>
                    </div>
                    <Select
                      value={brandSupplier[g.brand] ?? 'none'}
                      onValueChange={(v) =>
                        setBrandSupplier((m) => ({ ...m, [g.brand]: v === 'none' ? '' : v }))
                      }
                    >
                      <SelectTrigger className="h-8 w-44 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">暂不指定（先不下单）</SelectItem>
                        {suppliers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium">② 按供应商归纳 —— 一键生成订单（一个供应商一张外发订单）：</p>
              {supplierGroups.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                  还没有指定任何供应商；指定后此处会展示按供应商归纳的订单预览
                </div>
              ) : (
                <div className="space-y-2">
                  {supplierGroups.map((g) => (
                    <div key={g.supplierId} className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                      <ShoppingCart className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{g.supplierName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {g.brands.length} 个品牌 · {g.itemCount} 行材料 · 共 {g.qty} 件 → 将生成 1 张采购订单
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.brands.map((b) => (
                            <Badge key={b} variant="outline" className="text-[10px]">{b}</Badge>
                          ))}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">CG-*.xxx</Badge>
                    </div>
                  ))}
                </div>
              )}
              {unassignedBrands.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  未指定供应商：{unassignedBrands.map((b) => b.brand).join('、')} —— 这些材料将保留在采购任务中，
                  后续可在「供应商需求」Tab 指定供应商后点「按供应商生成订单」补生成
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Button size="sm" variant="ghost" onClick={() => setStep('edit')}>
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> 返回修改明细
              </Button>
              <Button size="sm" onClick={submit} disabled={submitting || rows.length === 0}>
                {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                一键生成采购订单（{supplierGroups.length} 张）
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: 结果 ── */}
        {step === 'result' && result && (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">导入完成，采购订单已生成</span>
            </div>
            <p className="text-sm">
              采购清单 <Badge variant="secondary" className="font-mono">{result.request.code}</Badge>
              （{result.request.itemCount} 行明细）已按品牌分解并归单：
            </p>
            {result.orders.length > 0 && (
              <div className="space-y-1.5">
                {result.orders.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <button
                      type="button"
                      className="font-mono text-primary underline-offset-2 hover:underline"
                      onClick={() => {
                        onOpenChange(false)
                        onViewOrder?.(o.id)
                      }}
                    >
                      {o.code}
                    </button>
                    <span className="text-muted-foreground">
                      {o.supplierName} · {o.itemCount} 行 · 品牌：{o.brands.join('、') || '—'}
                    </span>
                    <Badge variant="outline" className="ml-auto text-[10px]">草稿 · 待推进合同</Badge>
                  </div>
                ))}
              </div>
            )}
            {result.pendingSrs.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                待指定供应商：{result.pendingSrs.map((s) => s.code).join('、')}（品牌：
                {result.pendingSrs.map((s) => s.brand).join('、')}）—— 到「供应商需求」Tab
                打开任务指定供应商后，勾选并点「按供应商生成订单」
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>继续导入下一份</Button>
              {result.orders[0] && (
                <Button size="sm" onClick={() => {
                  onOpenChange(false)
                  onViewOrder?.(result.orders[0]!.id)
                }}>
                  查看订单并推进合同
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
