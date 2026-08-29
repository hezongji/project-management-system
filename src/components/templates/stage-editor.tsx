'use client'

/**
 * 流程模板阶段编辑器（共享组件）—— 依据《开发文档-项目管理系统重构》§8.2⑦
 *
 * 模板管理页（自定义模板编辑）与新建项目向导第 2 步（自定义编辑器入口）共用。
 * 能力：阶段拖拽排序（HTML5 原生拖拽 + 上移/下移按钮兜底）/ 增删阶段 /
 * 任意位置插入阶段（行内「插入」= 在该行之后插入；底部「添加阶段」= 末尾追加，
 * order 由数组序号派生，提交端重编 1..n）/ 阶段名编辑 / 负责岗位下拉选择（岗位字典）。
 * deliverables 可选可编辑（deliverablesEditable）：增删改 名称/必填/用途/范围；
 * 关闭时只读透传（拷贝模板时原样保留）。checklist 只读透传。
 *
 * props:
 *  - stages / onStagesChange：受控（order 由数组序号派生，提交端重编 1..n）
 *  - jobTitles：岗位字典名列表（下拉数据源）
 *  - readOnly：阶段名/增删/排序锁定（默认模板只读场景仍可用 jobTitleSelectEnabled 单独放开岗位）
 *  - jobTitleSelectEnabled：岗位下拉是否可改（默认模板「只读但可改各阶段岗位」）
 *  - deliverablesEditable：交付物清单是否可编辑（模板编辑器开启；向导默认关闭）
 */

import * as React from 'react'
import {
  GripVertical,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EditableStage, DeliverableDef } from '@/services/template'

const NONE_TITLE = '__none__'

const SCOPE_OPTIONS: Array<{ value: NonNullable<DeliverableDef['scope']>; label: string }> = [
  { value: 'PUBLIC', label: '公开' },
  { value: 'RESTRICTED', label: '受限' },
  { value: 'PRIVATE', label: '私有' },
]

interface StageEditorProps {
  stages: EditableStage[]
  onStagesChange: (stages: EditableStage[]) => void
  jobTitles: string[]
  readOnly?: boolean
  /** 只读场景下单独放开岗位下拉（默认模板「可改各阶段岗位」） */
  jobTitleSelectEnabled?: boolean
  /** 交付物清单可编辑（模板编辑器场景） */
  deliverablesEditable?: boolean
}

export function StageEditor({
  stages,
  onStagesChange,
  jobTitles,
  readOnly = false,
  jobTitleSelectEnabled = !readOnly,
  deliverablesEditable = false,
}: StageEditorProps) {
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [overIndex, setOverIndex] = React.useState<number | null>(null)
  /** 展开交付物编辑面板的阶段下标集合 */
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())

  const move = (from: number, to: number) => {
    if (to < 0 || to >= stages.length || from === to) return
    const next = [...stages]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onStagesChange(next)
  }

  const update = (i: number, patch: Partial<EditableStage>) => {
    const next = [...stages]
    next[i] = { ...next[i], ...patch }
    onStagesChange(next)
  }

  const remove = (i: number) => {
    onStagesChange(stages.filter((_, idx) => idx !== i))
  }

  /** 在指定位置插入空阶段（insertAt=末尾即追加） */
  const insertAt = (insertAt: number) => {
    const next = [...stages]
    next.splice(insertAt, 0, { name: '', ownerJobTitle: null, deliverables: null, checklist: null })
    onStagesChange(next)
  }

  const add = () => insertAt(stages.length)

  const toggleExpand = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // ───────────── 交付物维护（deliverablesEditable） ─────────────

  const updateDeliverable = (si: number, di: number, patch: Partial<DeliverableDef>) => {
    const list = [...(stages[si].deliverables ?? [])]
    list[di] = { ...list[di], ...patch }
    update(si, { deliverables: list })
  }

  const removeDeliverable = (si: number, di: number) => {
    const list = (stages[si].deliverables ?? []).filter((_, idx) => idx !== di)
    update(si, { deliverables: list })
  }

  const addDeliverable = (si: number) => {
    const list = [...(stages[si].deliverables ?? []), { name: '', required: true }]
    update(si, { deliverables: list })
    setExpanded((prev) => new Set(prev).add(si))
  }

  return (
    <div className="space-y-2">
      {stages.map((s, i) => (
        <div key={s.id ?? `new-${i}`} className="space-y-1">
          <div
            draggable={!readOnly && stages.length > 1}
            onDragStart={(e) => {
              setDragIndex(i)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setOverIndex(i)
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex !== null) move(dragIndex, i)
              setDragIndex(null)
              setOverIndex(null)
            }}
            className={cn(
              'flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2',
              dragIndex === i && 'opacity-50',
              overIndex === i && dragIndex !== null && dragIndex !== i && 'border-primary ring-1 ring-primary',
              !readOnly && stages.length > 1 && 'cursor-grab active:cursor-grabbing',
            )}
          >
            {/* 序号 + 拖拽把手 */}
            <div className="flex items-center gap-1">
              {!readOnly && stages.length > 1 ? (
                <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="w-8 shrink-0 text-center text-sm font-mono text-muted-foreground">
                {String(i + 1).padStart(2, '0')}
              </span>
            </div>

            {/* 阶段名 */}
            {readOnly ? (
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name || '（未命名）'}</span>
            ) : (
              <Input
                value={s.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="阶段名称"
                className="h-8 min-w-0 flex-1"
              />
            )}

            {/* 负责岗位 */}
            <Select
              value={s.ownerJobTitle ?? NONE_TITLE}
              onValueChange={(v) => update(i, { ownerJobTitle: v === NONE_TITLE ? null : v })}
              disabled={!jobTitleSelectEnabled}
            >
              <SelectTrigger className="h-8 w-[150px] shrink-0">
                <SelectValue placeholder="负责岗位" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_TITLE}>
                  <span className="text-muted-foreground">不指定岗位</span>
                </SelectItem>
                {jobTitles.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* 交付物：可编辑时为展开按钮，否则只读计数 */}
            {deliverablesEditable && !readOnly ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => toggleExpand(i)}
                aria-label="编辑交付物"
                title="编辑本阶段交付物清单"
              >
                {expanded.has(i) ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <FileText className="h-3.5 w-3.5" />
                交付物 {s.deliverables?.length ?? 0}
              </Button>
            ) : s.deliverables && s.deliverables.length > 0 ? (
              <span
                className="hidden items-center gap-1 text-xs text-muted-foreground md:inline-flex"
                title={s.deliverables.map((d) => `${d.name}${d.required ? '' : '（非必需）'}`).join('、')}
              >
                <FileText className="h-3.5 w-3.5" />
                {s.deliverables.length}
              </span>
            ) : null}

            {/* 排序/插入/删除 */}
            <div className="ml-auto flex items-center gap-1">
              {!readOnly ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label="上移"
                    title="上移"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => move(i, i + 1)}
                    disabled={i === stages.length - 1}
                    aria-label="下移"
                    title="下移"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => insertAt(i + 1)}
                    aria-label="在此行后插入阶段"
                    title="在此行后插入新阶段"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => remove(i)}
                    disabled={stages.length <= 1}
                    aria-label="删除阶段"
                    title="删除阶段"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {/* 交付物编辑面板 */}
          {deliverablesEditable && !readOnly && expanded.has(i) ? (
            <div className="ml-8 space-y-2 rounded-md border border-dashed bg-muted/30 p-3">
              {(s.deliverables ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">本阶段暂无交付物定义。</p>
              ) : null}
              {(s.deliverables ?? []).map((d, di) => (
                <div key={di} className="flex flex-wrap items-center gap-2">
                  <Input
                    value={d.name}
                    onChange={(e) => updateDeliverable(i, di, { name: e.target.value })}
                    placeholder="交付物名称"
                    className="h-8 w-40 min-w-0 flex-1"
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={d.required ?? false}
                      onCheckedChange={(v) => updateDeliverable(i, di, { required: v === true })}
                    />
                    必填
                  </label>
                  <Input
                    value={d.purpose ?? ''}
                    onChange={(e) =>
                      updateDeliverable(i, di, { purpose: e.target.value || null })
                    }
                    placeholder="用途（选填，≤50字）"
                    maxLength={50}
                    className="h-8 w-44"
                  />
                  <Select
                    value={d.scope ?? 'PUBLIC'}
                    onValueChange={(v) =>
                      updateDeliverable(i, di, {
                        scope: v as NonNullable<DeliverableDef['scope']>,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 w-[88px] shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0 text-destructive hover:text-destructive"
                    onClick={() => removeDeliverable(i, di)}
                    aria-label="删除交付物"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => addDeliverable(i)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 添加交付物
              </Button>
            </div>
          ) : null}
        </div>
      ))}

      {!readOnly ? (
        <Button type="button" variant="outline" size="sm" onClick={add} className="w-full border-dashed">
          <Plus className="mr-1 h-4 w-4" /> 添加阶段（末尾）
        </Button>
      ) : null}
    </div>
  )
}

/** 阶段列表紧凑摘要（向导预览/模板卡片用） */
export function StageSummary({ stages }: { stages: EditableStage[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {stages.map((s, i) => (
        <Badge key={s.id ?? i} variant="secondary" className="font-normal">
          {String(i + 1).padStart(2, '0')} {s.name || '（未命名）'}
        </Badge>
      ))}
    </div>
  )
}
