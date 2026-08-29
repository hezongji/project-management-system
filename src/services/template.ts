/**
 * 流程模板 service —— 依据《开发文档-项目管理系统重构》§7.3
 * 走 src/services/api.ts 统一解包（§4 响应壳）。
 */

import { ApiService } from './api'
import type { ApiResponse } from '@/types'

function unwrap<T>(res: ApiResponse<T>): T {
  return res.data as T
}

// ───────────────────────────── 类型（与 API 返回对齐） ─────────────────────────────

export interface DeliverableDef {
  name: string
  required?: boolean
  purpose?: string | null
  scope?: 'PUBLIC' | 'RESTRICTED' | 'PRIVATE'
}

export interface TemplateStageDTO {
  id: string
  templateId: string
  name: string
  order: number
  ownerJobTitle: string | null
  deliverables: DeliverableDef[] | null
  checklist: string[] | null
}

export interface ProcessTemplateDTO {
  id: string
  name: string
  isDefault: boolean
  stages: TemplateStageDTO[]
  _count?: { projects: number }
  createdAt?: string
  updatedAt?: string
}

// ───────────────────────────── 编辑器本地阶段模型（order 由列表序号派生） ─────────────────────────────

export interface EditableStage {
  /** 原模板阶段 id（保留可溯源，提交时服务端忽略重生成） */
  id?: string
  name: string
  ownerJobTitle: string | null
  deliverables: DeliverableDef[] | null
  checklist: string[] | null
}

/** ProcessTemplate.stages → EditableStage[] */
export function toEditableStages(t: ProcessTemplateDTO): EditableStage[] {
  return t.stages.map((s) => ({
    id: s.id,
    name: s.name,
    ownerJobTitle: s.ownerJobTitle,
    deliverables: s.deliverables,
    checklist: s.checklist,
  }))
}

/** EditableStage[] → API stages 载荷（order 按数组序重编） */
export function toApiStages(stages: EditableStage[]): Array<
  Omit<TemplateStageDTO, 'id' | 'templateId' | 'order'> & { order: number }
> {
  return stages.map((s, i) => ({
    name: s.name,
    order: i + 1,
    ownerJobTitle: s.ownerJobTitle,
    deliverables: s.deliverables ?? [],
    checklist: s.checklist ?? [],
  }))
}

// ───────────────────────────── service ─────────────────────────────

export const ProcessTemplateService = {
  list: () =>
    ApiService.get<{ items: ProcessTemplateDTO[] }>('/process-templates').then((r) =>
      unwrap(r).items,
    ),

  create: (input: {
    name: string
    isDefault?: boolean
    stages: ReturnType<typeof toApiStages>
  }) => ApiService.post<ProcessTemplateDTO>('/process-templates', input).then((r) => unwrap(r)),

  /** 默认模板：仅调整各阶段负责岗位 */
  patchDefaultJobTitles: (
    id: string,
    stages: Array<{ id: string; ownerJobTitle: string | null }>,
  ) => ApiService.patch<ProcessTemplateDTO>(`/process-templates/${id}`, { stages }).then((r) => unwrap(r)),

  update: (
    id: string,
    input: {
      name?: string
      isDefault?: boolean
      stages?: ReturnType<typeof toApiStages>
    },
  ) => ApiService.patch<ProcessTemplateDTO>(`/process-templates/${id}`, input).then((r) => unwrap(r)),

  remove: (id: string) => ApiService.delete<{ id: string }>(`/process-templates/${id}`).then((r) => unwrap(r)),
}
