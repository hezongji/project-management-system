/**
 * /api/process-templates/[id] —— 依据《开发文档-项目管理系统重构》§7.3
 *
 * PATCH   ADMIN  维护模板；默认模板只读保护：仅允许调整各阶段负责岗位
 *         （模板管理页契约「默认20步模板只读但可改各阶段岗位」，服务端同步收口）
 * DELETE  ADMIN  删除模板；唯一默认模板不可删；已被项目引用的模板不可删
 *         （Project.templateId 溯源用，删除会静默置空 → 400 拒绝，保护台账可追溯）
 *
 * PATCH 语义：
 *  - name / isDefault：非默认模板可改；isDefault=true → 旧默认自动取消；
 *    当前默认模板 isDefault=false → 400（系统恒有且仅有一个默认模板）
 *  - stages：非默认模板整表替换（事务内删旧建新，order 重编 1..n；
 *    TemplateStage.id 无外部引用，重建安全——项目实例化时已快照到 Phase）
 *  - 默认模板：请求体只接受 stages:[{id, ownerJobTitle}]，阶段集合不可增删改名
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { stageSchema, normalizeStages } from '@/lib/template-schemas'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** 默认模板允许的请求体（仅岗位调整） */
const defaultPatchSchema = z.object({
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        ownerJobTitle: z.string().trim().max(50).nullable().optional(),
      }),
    )
    .min(1),
})

/** 普通模板允许的请求体 */
const patchSchema = z.object({
  name: z.string().trim().min(1, '模板名称不能为空').max(100).optional(),
  isDefault: z.boolean().optional(),
  stages: z.array(stageSchema).min(1, '模板至少需要一个阶段').max(99).optional(),
})

async function assertJobTitlesValid(names: (string | null | undefined)[]) {
  const jobTitles = new Set(
    (await prisma.jobTitle.findMany({ select: { name: true } })).map((t) => t.name),
  )
  for (const name of names) {
    if (name && !jobTitles.has(name)) {
      throw ApiError.badRequest(`负责岗位「${name}」不存在于岗位字典`)
    }
  }
}

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const raw = await request.json()
  const template = await prisma.processTemplate.findUnique({
    where: { id: id },
    include: { stages: { orderBy: { order: 'asc' } } },
  })
  if (!template) throw ApiError.notFound('流程模板不存在')

  const updated = await prisma.$transaction(async (tx) => {
    // ── 默认模板：只读保护，仅岗位可调 ──
    if (template.isDefault) {
      const body = defaultPatchSchema.parse(raw)

      const stageIds = new Set(template.stages.map((s) => s.id))
      for (const s of body.stages) {
        if (!stageIds.has(s.id)) {
          throw ApiError.badRequest('默认模板为只读：不可新增或引用不存在的阶段')
        }
      }
      if (body.stages.length !== template.stages.length) {
        throw ApiError.badRequest('默认模板为只读：阶段不可删除')
      }
      await assertJobTitlesValid(body.stages.map((s) => s.ownerJobTitle))

      for (const s of body.stages) {
        if (s.ownerJobTitle !== undefined) {
          await tx.templateStage.update({
            where: { id: s.id },
            data: { ownerJobTitle: s.ownerJobTitle || null },
          })
        }
      }
      return tx.processTemplate.findUniqueOrThrow({
        where: { id: template.id },
        include: { stages: { orderBy: { order: 'asc' } }, _count: { select: { projects: true } } },
      })
    }

    // ── 非默认模板：全量维护 ──
    const body = patchSchema.parse(raw)
    if (body.isDefault === false) {
      throw ApiError.badRequest('不可直接取消默认模板：请先将其他模板设为默认')
    }
    if (body.name !== undefined && body.name !== template.name) {
      const dup = await tx.processTemplate.findFirst({ where: { name: body.name } })
      if (dup) throw new ApiError(409, `模板「${body.name}」已存在`, 'CONFLICT')
    }
    if (body.stages) {
      await assertJobTitlesValid(body.stages.map((s) => s.ownerJobTitle))
    }

    if (body.isDefault === true) {
      await tx.processTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }

    if (body.stages) {
      const stages = normalizeStages(body.stages).map((s) => ({
        name: s.name,
        order: s.order,
        ownerJobTitle: s.ownerJobTitle,
        ...(s.deliverables && s.deliverables.length > 0 ? { deliverables: s.deliverables } : {}),
        ...(s.checklist && s.checklist.length > 0 ? { checklist: s.checklist } : {}),
      }))
      // 整表替换（TemplateStage.id 无外部引用，重建安全）
      await tx.templateStage.deleteMany({ where: { templateId: template.id } })
      await tx.processTemplate.update({
        where: { id: template.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          stages: { create: stages },
        },
      })
    } else {
      await tx.processTemplate.update({
        where: { id: template.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        },
      })
    }

    return tx.processTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { stages: { orderBy: { order: 'asc' } }, _count: { select: { projects: true } } },
    })
  })

  return ok(updated, '模板已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const template = await prisma.processTemplate.findUnique({
    where: { id: id },
    include: { _count: { select: { projects: true } } },
  })
  if (!template) throw ApiError.notFound('流程模板不存在')

  if (template.isDefault) {
    throw ApiError.badRequest('唯一默认模板不可删除（新建项目未指定模板时的兜底流程）')
  }
  if (template._count.projects > 0) {
    throw ApiError.badRequest(
      `模板已被 ${template._count.projects} 个项目引用，不可删除（保留项目流程溯源）`,
    )
  }

  await prisma.processTemplate.delete({ where: { id: template.id } })
  return ok({ id: template.id }, `模板「${template.name}」已删除`)
})
