'use client'

/**
 * 采购清单 Excel 导入弹窗（2026-08-22 用户需求）
 *
 * 流程：选项目 → 下载模板/上传 Excel → 前端解析预览（自动按「类别×供应商」分组）→ 确认导入
 * 后端 POST /api/purchase-requests/import：创建采购清单 + 自动分解为多张供应商需求单
 */

import * as React from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { ApiService } from '@/services/api'
import { downloadPurchaseTemplate } from '@/lib/excel-templates'
import { FileSpreadsheet, Upload, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'

interface ParsedRow {
  name: string
  spec: string
  quantity: number
  unit: string
  brand: string
  category: string
  supplierName: string
  price: number | null
  remark: string
}

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName?: string
  onImported?: () => void
}

const CATEGORY_MAP: Record<string, string> = {
  机械: 'MECHANICAL',
  电气: 'ELECTRICAL',
  其他: 'OTHER',
  MECHANICAL: 'MECHANICAL',
  ELECTRICAL: 'ELECTRICAL',
  OTHER: 'OTHER',
}

export function PurchaseImportDialog({ open, onOpenChange, projectId, projectName, onImported }: ImportDialogProps) {
  const { toast } = useToast()
  const [rows, setRows] = React.useState<ParsedRow[] | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [result, setResult] = React.useState<{ requestCode: string; srCount: number; unmatched: string[]; orders: Array<{ orderCode: string; title: string }> } | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  // 项目选择（外部未指定时弹窗内选）
  const [selectedProjectId, setSelectedProjectId] = React.useState(projectId)
  const [projects, setProjects] = React.useState<Array<{ id: string; code: string; name: string }>>([])
  const [projectsLoading, setProjectsLoading] = React.useState(false)

  React.useEffect(() => {
    setSelectedProjectId(projectId)
  }, [projectId])

  // 未指定项目时拉项目列表
  React.useEffect(() => {
    if (open && !projectId && projects.length === 0 && !projectsLoading) {
      setProjectsLoading(true)
      ApiService.get<{ items: Array<{ id: string; code: string; name: string }> }>('/projects', { limit: 100 })
        .then((r) => setProjects(r.data?.items ?? []))
        .catch(() => {})
        .finally(() => setProjectsLoading(false))
    }
  }, [open, projectId, projects.length, projectsLoading])

  const effectiveProjectId = selectedProjectId || projectId

  // 重置状态
  React.useEffect(() => {
    if (open) {
      setRows(null)
      setResult(null)
      setImporting(false)
    }
  }, [open])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1 }) as unknown as (string | number)[][]
      // 跳过表头（第一行）
      const dataRows = aoa.slice(1).filter((r) => r && r.length > 0 && String(r[0] ?? '').trim() !== '')
      const parsed: ParsedRow[] = dataRows.map((r) => {
        const qty = Number(r[2])
        const priceNum = Number(r[7])
        return {
          name: String(r[0] ?? '').trim(),
          spec: String(r[1] ?? '').trim(),
          quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
          unit: String(r[3] ?? '').trim() || '件',
          brand: String(r[4] ?? '').trim(),
          category: CATEGORY_MAP[String(r[5] ?? '').trim()] ?? 'OTHER',
          supplierName: String(r[6] ?? '').trim(),
          price: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null,
          remark: String(r[8] ?? '').trim(),
        }
      })
      if (parsed.length === 0) {
        toast({ variant: 'destructive', description: 'Excel 中没有有效数据行' })
        return
      }
      setRows(parsed)
    } catch (err) {
      toast({ variant: 'destructive', description: '解析失败：' + (err instanceof Error ? err.message : '文件格式错误') })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // 分组预览：类别 × 供应商
  const groups = React.useMemo(() => {
    if (!rows) return []
    const map = new Map<string, { label: string; count: number; qty: number }>()
    for (const r of rows) {
      const cat = r.category === 'MECHANICAL' ? '机械' : r.category === 'ELECTRICAL' ? '电气' : '其他'
      const key = `${cat}|${r.supplierName || '(未指定供应商)'}`
      const g = map.get(key) ?? { label: key, count: 0, qty: 0 }
      g.count += 1
      g.qty += r.quantity
      map.set(key, g)
    }
    return Array.from(map.values()).map((g) => {
      const [cat, sup] = g.label.split('|')
      return { cat, supplier: sup, count: g.count, qty: g.qty }
    })
  }, [rows])

  const doImport = async () => {
    if (!rows || importing) return
    setImporting(true)
    try {
      if (!effectiveProjectId) {
        toast({ variant: 'destructive', description: '请先选择项目' })
        return
      }
      const res = await ApiService.post('/purchase-requests/import', {
        projectId: effectiveProjectId,
        autoDecompose: true,
        // 过滤 null 字段（后端 zod 不接受 null），price 无值不传
        rows: rows.map((r) => ({
          name: r.name,
          spec: r.spec || undefined,
          quantity: r.quantity,
          unit: r.unit || undefined,
          brand: r.brand || undefined,
          category: r.category,
          supplierName: r.supplierName || undefined,
          ...(r.price != null ? { price: r.price } : {}),
          remark: r.remark || undefined,
        })),
      })
      const data = res.data as {
        request?: { code: string }
        supplierRequests?: Array<{ code: string; title: string | null; orderCode: string }>
      }
      setResult({
        requestCode: data?.request?.code ?? '',
        srCount: data?.supplierRequests?.length ?? 0,
        unmatched: [],
        orders: (data?.supplierRequests ?? []).map((sr) => ({
          orderCode: sr.orderCode ?? '',
          title: sr.title ?? '',
        })),
      })
      toast({ description: res.message ?? '导入成功' })
      onImported?.()
    } catch (err) {
      toast({ variant: 'destructive', description: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
            导入 Excel 采购清单
          </DialogTitle>
          <DialogDescription>
            上传后自动按「类别 × 供应商」分解采购任务，自动创建采购计划与供应商需求单
            {projectName ? `（项目：${projectName}）` : ''}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          /* ── 导入完成结果 ── */
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">导入完成</span>
            </div>
            <p className="text-sm">
              采购清单 <Badge variant="secondary" className="font-mono">{result.requestCode}</Badge> 已创建，
              自动生成 <Badge className="font-mono">{result.srCount}</Badge> 张采购订单：
            </p>
            {(result.orders ?? []).length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border p-2">
                {result.orders.map((o, i) => (
                  <p key={i} className="flex items-center gap-2 py-0.5 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="font-mono text-primary">{o.orderCode}</span>
                    <span className="truncate text-muted-foreground">{o.title}</span>
                  </p>
                ))}
              </div>
            )}
            {result.unmatched.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                以下供应商未匹配到档案（保留在清单中待分配）：{result.unmatched.join('、')}
              </p>
            )}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>关闭</Button>
            </DialogFooter>
          </div>
        ) : rows === null ? (
          /* ── 上传区 ── */
          <div className="space-y-3 py-2">
            {!projectId && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">选择项目：</p>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">{projectsLoading ? '加载中…' : '请选择项目'}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">拖拽或点击上传 .xlsx 文件</p>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                选择 Excel 文件
              </Button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
            </div>
            <p className="text-center text-xs text-muted-foreground">
              列格式：物料名称* / 规格型号 / 数量* / 单位 / 品牌 / 类别(机械|电气) / 供应商 / 单价 / 备注
            </p>
            <div className="text-center">
              <Button variant="ghost" size="sm" onClick={() => downloadPurchaseTemplate()}>
                <FileSpreadsheet className="mr-1 h-4 w-4" /> 下载导入模板
              </Button>
            </div>
          </div>
        ) : (
          /* ── 解析预览 ── */
          <div className="space-y-3 py-2">
            <p className="text-sm">
              解析 <Badge variant="secondary">{rows.length}</Badge> 行明细，自动分解为{' '}
              <Badge variant="secondary">{groups.length}</Badge> 组采购任务：
            </p>
            <div className="max-h-48 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">类别</th>
                    <th className="px-3 py-1.5 font-medium">供应商</th>
                    <th className="px-3 py-1.5 font-medium">明细行数</th>
                    <th className="px-3 py-1.5 text-right font-medium">总数量</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5">
                        <Badge variant={g.cat === '机械' ? 'secondary' : g.cat === '电气' ? 'default' : 'outline'}>{g.cat}</Badge>
                      </td>
                      <td className="px-3 py-1.5">{g.supplier}</td>
                      <td className="px-3 py-1.5">{g.count} 行</td>
                      <td className="px-3 py-1.5 text-right">{g.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              ✓ 每组将自动创建「供应商需求单」并直接下单（生成采购订单）；
              未填供应商的行保留在采购清单中待分解
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setRows(null)}>
                重新选择
              </Button>
              <Button onClick={doImport} disabled={importing}>
                {importing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                确认导入
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
