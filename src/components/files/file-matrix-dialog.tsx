'use client'

/**
 * FileMatrixDialog —— 归档矩阵弹窗壳（§7.7 GET /projects/:id/file-matrix）
 * 内容渲染委托给 FileMatrix（components/files/file-matrix.tsx）：
 * 汇总统计 + 条目×状态矩阵 + 总表 + 缺项清单 + 归档按钮（拦截弹缺项）。
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FileMatrix } from './file-matrix'

export function FileMatrixDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>归档矩阵（文件核对表）</DialogTitle>
          <DialogDescription>
            必需条目须全部「已通过」（或标记不适用）方可归档；未通过条目列入缺项清单。
          </DialogDescription>
        </DialogHeader>
        <FileMatrix projectId={projectId} onArchived={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
