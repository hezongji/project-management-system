'use client'

/**
 * Excel 导入结果报告弹窗（users / external-orgs 两套共用）
 * 显示成功统计 + 错误行明细（行号/姓名/原因），支持复制错误清单。
 */

import * as React from 'react'
import { CheckCircle2, AlertTriangle, Copy } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ImportResult } from '@/services/org'
import { useToast } from '@/components/ui/use-toast'

export function ImportResultDialog({
  open,
  onOpenChange,
  result,
  title = '导入完成',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  result: ImportResult | null
  title?: string
}) {
  const { toast } = useToast()
  if (!result) return null

  const okCount =
    (result.created ?? result.updated ?? 0) ||
    (result.createdOrgs ?? result.updatedOrgs ?? 0) ||
    result.validRows ||
    0
  const summary: string[] = []
  if (result.dryRun) summary.push('试运行（未写入数据库）')
  if (result.created !== undefined) summary.push(`新建 ${result.created} 人`)
  if (result.updated !== undefined) summary.push(`更新 ${result.updated} 人`)
  if (result.createdOrgs !== undefined) summary.push(`新建主体 ${result.createdOrgs} 家`)
  if (result.updatedOrgs !== undefined) summary.push(`更新主体 ${result.updatedOrgs} 家`)
  if (result.addedContacts !== undefined) summary.push(`新增联系人 ${result.addedContacts} 名`)
  if (result.wouldCreate !== undefined) summary.push(`将新建 ${result.wouldCreate} 人`)
  if (result.wouldUpdate !== undefined) summary.push(`将更新 ${result.wouldUpdate} 人`)

  const errorText = result.errors
    .map((e) => `第 ${e.row} 行\t${e.name || e.email || ''}\t${e.reason}`)
    .join('\n')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {result.errors.length === 0 ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>
            共解析 {result.total} 行数据{summary.length > 0 && ` · ${summary.join(' · ')}`}
          </DialogDescription>
        </DialogHeader>

        {result.errors.length === 0 ? (
          <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            全部行校验通过{result.dryRun ? '，可去掉「仅校验」勾选后正式导入' : '，写入完成'}。
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-red-600">
                {result.errors.length} 行未通过校验（已跳过，其余 {okCount} 行正常处理）：
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard?.writeText(errorText)
                  toast({ description: '错误清单已复制到剪贴板' })
                }}
              >
                <Copy className="mr-1 h-3.5 w-3.5" /> 复制清单
              </Button>
            </div>
            <div className="max-h-72 overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">行号</th>
                    <th className="px-3 py-2 text-left font-medium">姓名/名称</th>
                    <th className="px-3 py-2 text-left font-medium">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5">
                        <Badge variant="destructive">{e.row}</Badge>
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{e.name || e.email || '-'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
