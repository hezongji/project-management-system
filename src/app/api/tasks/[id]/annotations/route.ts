/**
 * /api/tasks/[id]/annotations —— 依据《开发文档-项目管理系统重构》§7.6 / §5 Annotation
 *
 * POST  任务 view   加标注 body { field?, color?, note }：
 *        - field：锚定字段名（可空=整任务），限任务字段白名单
 *        - color：yellow/red/blue/green（默认 yellow）
 *        - note：批注内容（必填）
 *        （权限即任务 view：协作者皆可对任务贴便签，§7.6 字面）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { EngineError } from '@/lib/phase-engine'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/** 标注可锚定的任务字段（显示/比对用，与 §5 Task 模型对齐） */
const ANNOTATABLE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assignee',
  'dueDate',
  'phase',
] as const

const createSchema = z
  .object({
    field: z
      .string()
      .refine((v) => (ANNOTATABLE_FIELDS as readonly string[]).includes(v), {
        message: `field 只允许：${ANNOTATABLE_FIELDS.join(', ')}（或省略=整任务）`,
      })
      .optional()
      .nullable(),
    color: z.enum(['yellow', 'red', 'blue', 'green']).optional(),
    note: z.string().min(1, '批注内容不能为空').max(500, '批注内容不超过 500 字'),
  })
  .strict()

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'view', { type: 'TASK', id })

  const body = createSchema.parse(await request.json())

  const annotation = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    })
    if (!task) throw new EngineError(404, '任务不存在', 'NOT_FOUND')

    return tx.annotation.create({
      data: {
        taskId: task.id,
        userId: user.userId,
        field: body.field ?? null,
        color: body.color ?? 'yellow',
        note: body.note.trim(),
      },
      include: { user: { select: { id: true, name: true, avatar: true } } },
    })
  })

  return created(annotation, '标注已添加')
})
