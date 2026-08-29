/**
 * 流程模板共享校验 schema（服务端）—— 依据《开发文档-项目管理系统重构》§7.3
 *
 * 供 /api/process-templates 与 /api/process-templates/[id] 两个路由复用
 * （Next.js route 文件不允许导出除 HTTP 方法/路由配置外的成员，故独立成模块）。
 */

import { z } from 'zod'

/** 交付物条目（§5 TemplateStage.deliverables Json 数组元素 / §10.2） */
export const deliverableSchema = z.object({
  name: z.string().trim().min(1, '交付物名称不能为空').max(200),
  required: z.boolean().optional(),
  purpose: z.string().trim().max(50).nullable().optional(),
  scope: z.enum(['PUBLIC', 'RESTRICTED', 'PRIVATE']).optional(),
})

/** 模板阶段（§7.3 POST body stages 元素；id 仅编辑态携带，服务端忽略） */
export const stageSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, '阶段名称不能为空').max(100),
  order: z.number().int().min(1).max(99).optional(),
  ownerJobTitle: z.string().trim().max(50).nullable().optional(),
  deliverables: z.array(deliverableSchema).max(50).nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(50).nullable().optional(),
})

/** stages 排序后重编 1..n（phase-engine 依赖 order 连续生成 PHxx） */
export function normalizeStages<
  S extends { name: string; order?: number; ownerJobTitle?: string | null },
>(stages: S[]): Array<S & { order: number; ownerJobTitle: string | null }> {
  return [...stages]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s, i) => ({ ...s, order: i + 1, ownerJobTitle: s.ownerJobTitle || null }))
}
