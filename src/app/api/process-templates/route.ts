/**
 * /api/process-templates —— 依据《开发文档-项目管理系统重构》§7.3、§5 ProcessTemplate/TemplateStage
 *
 * GET   /api/process-templates  登录   模板列表（含 stages，isDefault 优先）
 * POST  /api/process-templates  ADMIN  新建模板 {name, isDefault, stages:[{name,ownerJobTitle,deliverables,checklist,order}]}
 *
 * 实现说明：
 *  - stages 按 order 升序后统一重编为 1..n（保证连续唯一，phase-engine 依赖 order 生成 PHxx）
 *  - ownerJobTitle 非空时校验必须存在于岗位字典（§5：引用 JobTitle.name，防脏数据导致自动匹配永远落空）
 *  - isDefault=true 时事务内先取消旧默认（系统恒有且仅有一个默认模板）
 *  - deliverables/checklist 原样透传（Json 字段，结构 {name,required,purpose,scope}[] / string[]）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { stageSchema, normalizeStages } from '@/lib/template-schemas'

export const dynamic = 'force-dynamic'

// ───────────────────────────── GET：列表（登录） ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)

  const templates = await prisma.processTemplate.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: {
      stages: { orderBy: { order: 'asc' } },
      _count: { select: { projects: true } },
    },
  })

  return ok({ items: templates })
})

// ───────────────────────────── POST：新建（ADMIN） ─────────────────────────────

const createSchema = z.object({
  name: z.string().trim().min(1, '模板名称不能为空').max(100),
  isDefault: z.boolean().optional().default(false),
  stages: z.array(stageSchema).min(1, '模板至少需要一个阶段').max(99),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const body = createSchema.parse(await request.json())

  // 岗位合法性校验（引用 JobTitle.name）
  const jobTitles = new Set(
    (await prisma.jobTitle.findMany({ select: { name: true } })).map((t) => t.name),
  )
  for (const s of body.stages) {
    if (s.ownerJobTitle && !jobTitles.has(s.ownerJobTitle)) {
      throw ApiError.badRequest(`阶段「${s.name}」的负责岗位「${s.ownerJobTitle}」不存在于岗位字典`)
    }
  }

  // 排序 + 重编 1..n
  const stages = normalizeStages(body.stages).map((s) => ({
    name: s.name,
    order: s.order,
    ownerJobTitle: s.ownerJobTitle,
    ...(s.deliverables && s.deliverables.length > 0 ? { deliverables: s.deliverables } : {}),
    ...(s.checklist && s.checklist.length > 0 ? { checklist: s.checklist } : {}),
  }))

  const template = await prisma.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.processTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }
    return tx.processTemplate.create({
      data: {
        name: body.name,
        isDefault: body.isDefault,
        stages: { create: stages },
      },
      include: { stages: { orderBy: { order: 'asc' } }, _count: { select: { projects: true } } },
    })
  })

  return created(template, `模板「${template.name}」已创建（${stages.length} 个阶段）`)
})
