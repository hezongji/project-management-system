'use client'

/**
 * RequirementFormDialog —— 文件条目新建/编辑弹窗（§7.7 POST/PATCH 请求体）
 *
 * 字段：名称*、编号、所属目录*、关联阶段、责任人、外部提供方、用途、
 *       开放范围、截止日期、必需、备注。
 * 责任人/审核人下拉来自项目成员，外部提供方来自外部主体，目录来自目录树展平。
 * scopeRefs（指定范围名单）本阶段暂不在表单编辑，保留 null（P2-3 权限矩阵再接）。
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
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
import { SCOPE_LABEL } from './badges'
import type {
  CatalogNode,
  FileRequirementItem,
  FileScope,
  ProjectMemberOption,
  RequirementInput,
} from '@/types/files'

const SCOPES: FileScope[] = ['PUBLIC', 'RESTRICTED', 'PRIVATE']

export function RequirementFormDialog({
  open,
  onOpenChange,
  projectId,
  catalogs,
  members,
  externalOrgs,
  item,
  defaultCatalogId,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  catalogs: CatalogNode[]
  members: ProjectMemberOption[]
  externalOrgs: { id: string; name: string }[]
  item: FileRequirementItem | null
  defaultCatalogId: string | null
  onSave: (input: RequirementInput) => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [catalogId, setCatalogId] = useState('')
  const [phaseCode, setPhaseCode] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [externalOrgId, setExternalOrgId] = useState('')
  const [purpose, setPurpose] = useState('')
  const [scope, setScope] = useState<FileScope>('PUBLIC')
  const [dueDate, setDueDate] = useState('')
  const [required, setRequired] = useState(true)
  const [reviewerId, setReviewerId] = useState('')
  const [remark, setRemark] = useState('')

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setCode(item?.code ?? '')
    setCatalogId(item?.catalogId ?? defaultCatalogId ?? '')
    setPhaseCode(item?.phaseCode ?? '')
    setOwnerId(item?.ownerId ?? '')
    setExternalOrgId(item?.externalOrgId ?? '')
    setPurpose(item?.purpose ?? '')
    setScope(item?.scope ?? 'PUBLIC')
    setDueDate(item?.dueDate ? item.dueDate.slice(0, 10) : '')
    setRequired(item?.required ?? true)
    setReviewerId(item?.reviewerId ?? '')
    setRemark(item?.remark ?? '')
  }, [open, item, defaultCatalogId])

  const isEdit = !!item
  const valid = name.trim() && catalogId

  function submit() {
    if (!valid) return
    onSave({
      projectId,
      catalogId,
      name: name.trim(),
      code: code.trim() || null,
      phaseCode: phaseCode.trim() || null,
      ownerId: ownerId || null,
      externalOrgId: externalOrgId || null,
      purpose: purpose.trim() || null,
      scope,
      scopeRefs: item?.scopeRefs ?? null,
      dueDate: dueDate || null,
      required,
      reviewerId: reviewerId || null,
      remark: remark.trim() || null,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑文件条目' : '新建文件条目'}</DialogTitle>
          <DialogDescription>
            {isEdit ? `修改「${item?.name}」的属性` : '手动添加交付文件条目'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="grid grid-cols-2 gap-4"
        >
          <div className="col-span-2 space-y-2">
            <Label htmlFor="req-name">文件名称 *</Label>
            <Input id="req-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：电气原理图" autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="req-code">文件编号</Label>
            <Input id="req-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="PROJ-PH05-E-001" />
          </div>
          <div className="space-y-2">
            <Label>所属目录 *</Label>
            <Select value={catalogId} onValueChange={setCatalogId}>
              <SelectTrigger>
                <SelectValue placeholder="选择目录" />
              </SelectTrigger>
              <SelectContent>
                {catalogs.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="req-phase">关联阶段</Label>
            <Input id="req-phase" value={phaseCode} onChange={(e) => setPhaseCode(e.target.value)} placeholder="PH05" />
          </div>
          <div className="space-y-2">
            <Label>责任人</Label>
            <Select value={ownerId} onValueChange={setOwnerId}>
              <SelectTrigger>
                <SelectValue placeholder="选择责任人" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>审核人</Label>
            <Select value={reviewerId} onValueChange={setReviewerId}>
              <SelectTrigger>
                <SelectValue placeholder="默认阶段负责人" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>外部提供方</Label>
            <Select value={externalOrgId} onValueChange={setExternalOrgId}>
              <SelectTrigger>
                <SelectValue placeholder="无" />
              </SelectTrigger>
              <SelectContent>
                {externalOrgs.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>开放范围</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as FileScope)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="req-due">截止日期</Label>
            <Input id="req-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="flex items-end space-x-2 pb-2">
            <Checkbox id="req-required" checked={required} onCheckedChange={(v) => setRequired(v === true)} />
            <Label htmlFor="req-required" className="cursor-pointer">
              必需（归档拦截项）
            </Label>
          </div>
          <div className="col-span-2 space-y-2">
            <Label htmlFor="req-purpose">用途</Label>
            <Input id="req-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="报审 / 存档 / 客户交付 / 施工依据" />
          </div>
          <div className="col-span-2 space-y-2">
            <Label htmlFor="req-remark">备注</Label>
            <Textarea id="req-remark" value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} />
          </div>
          <DialogFooter className="col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !valid}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? '保存修改' : '创建条目'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
