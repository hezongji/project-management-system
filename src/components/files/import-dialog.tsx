'use client'

/**
 * ImportDialog —— 文件条目 Excel 批量导入（§7.7 POST /file-requirements/import）
 *
 * 支持「仅校验」（dryRun）先试运行，再正式导入；下载模板 + 错误行报告。
 * 复用 excel-templates.downloadRequirementsTemplate 模板下载。
 */

import { useRef, useState } from 'react'
import { Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { FilesService } from '@/services/files'
import { downloadRequirementsTemplate } from '@/lib/excel-templates'
import { ApiError } from '@/services/api'
import type { RequirementImportResult } from '@/types/files'

export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  onImported: () => void
}) {
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<RequirementImportResult | null>(null)

  function reset() {
    setFile(null)
    setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleImport() {
    if (!file) {
      toast({ title: '请先选择 Excel 文件', variant: 'destructive' })
      return
    }
    setImporting(true)
    setResult(null)
    try {
      const res = await FilesService.importRequirements(projectId, file, dryRun)
      setResult(res)
      if (!dryRun && res.created) {
        toast({ description: `成功导入 ${res.created} 条文件条目` })
        onImported()
      }
    } catch (err) {
      toast({
        title: '导入失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Excel 批量导入文件条目</DialogTitle>
          <DialogDescription>
            列定义：文件名称* 文件编号 目录* 阶段 责任人 外部提供方 用途 开放范围 截止日期 必需 备注
            （目录/责任人/外部提供方按名称匹配）
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadRequirementsTemplate().catch(() => {})}
            >
              <Download className="mr-1 h-4 w-4" />
              下载模板
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setResult(null)
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <FileSpreadsheet className="mr-1 h-4 w-4" />
              {file ? file.name : '选择文件'}
            </Button>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={dryRun} onCheckedChange={(v) => setDryRun(v === true)} />
            仅校验（试运行，不写入数据库）
          </label>

          {result && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">共 {result.total} 行</Badge>
                <Badge variant="secondary">有效 {result.validRows} 行</Badge>
                {result.dryRun ? (
                  <Badge variant="secondary">将新建 {result.wouldCreate ?? 0} 条</Badge>
                ) : (
                  <Badge variant="secondary">已新建 {result.created ?? 0} 条</Badge>
                )}
                {result.skippedDuplicate ? (
                  <Badge variant="outline">跳过重复 {result.skippedDuplicate} 条</Badge>
                ) : null}
              </div>
              {result.errors.length === 0 ? (
                <p className="text-sm text-green-700">全部行校验通过。</p>
              ) : (
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">行号</th>
                        <th className="px-2 py-1 text-left font-medium">名称</th>
                        <th className="px-2 py-1 text-left font-medium">原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((e, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1"><Badge variant="destructive">{e.row}</Badge></td>
                          <td className="px-2 py-1 whitespace-nowrap">{e.name || '-'}</td>
                          <td className="px-2 py-1 text-muted-foreground">{e.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); reset() }}>
            关闭
          </Button>
          <Button onClick={handleImport} disabled={importing || !file}>
            {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Upload className="mr-1 h-4 w-4" />
            {dryRun ? '校验' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
