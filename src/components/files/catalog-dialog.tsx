'use client'

/**
 * CatalogDialog —— 目录新建/重命名弹窗（§8.2④ 右键增删改）
 * 字段：名称（必填）、关联阶段（可选）、备注（可选）；父目录由调用方决定（重命名不带父级）。
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CatalogNode } from '@/types/files'

export interface CatalogFormValue {
  name: string
  phaseCode: string
  remark: string
}

export function CatalogDialog({
  open,
  onOpenChange,
  parent,
  node,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 新建时：父目录（null = 根目录） */
  parent: CatalogNode | null
  /** 重命名时：被编辑节点 */
  node: CatalogNode | null
  onSave: (value: CatalogFormValue) => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [phaseCode, setPhaseCode] = useState('')
  const [remark, setRemark] = useState('')

  useEffect(() => {
    if (open) {
      setName(node?.name ?? '')
      setPhaseCode(node?.phaseCode ?? '')
      setRemark(node?.remark ?? '')
    }
  }, [open, node])

  const isEdit = !!node

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '重命名目录' : '新建目录'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `修改目录「${node?.name}」的信息`
              : parent
                ? `在「${parent.name}」下新建子目录`
                : '新建根目录'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave({ name: name.trim(), phaseCode: phaseCode.trim(), remark: remark.trim() })
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="cat-name">目录名称 *</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：05-电气设计"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-phase">关联阶段（可选）</Label>
            <Input
              id="cat-phase"
              value={phaseCode}
              onChange={(e) => setPhaseCode(e.target.value)}
              placeholder="如：PH05"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-remark">备注（可选）</Label>
            <Textarea
              id="cat-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="用途说明"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
