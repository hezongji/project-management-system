/**
 * PATCH /api/todos/:id —— 依据《开发文档-项目管理系统重构》§7.9
 *
 * body { done?: boolean, dueAt?: string|null }
 *   - done=true  → doneAt=now（完成）
 *   - done=false → doneAt=null（撤销完成）
 *   - dueAt      → 延期/调整到期时间（ISO 串，null 清除）
 * 校验待办属于本人（userId 匹配），否则 404/403。
 *
 * DELETE /api/todos/:id —— 删除单条待办（删除工程第 5 棒 · 消息域）
 *   - 仅本人（todoItem.userId===authUser.userId）可删；logDelete 审计。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const patchSchema = z
  .object({
    done: z.boolean().optional(),
    dueAt: z.string().nullable().optional(),
  })
  .strict()

export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  const existing = await prisma.todoItem.findUnique({ where: { id } })
  if (!existing) throw ApiError.notFound('待办不存在')
  if (existing.userId !== user.userId) throw ApiError.forbidden('无权操作他人的待办')

  const body = patchSchema.parse(await request.json())
  if (Object.keys(body).length === 0) {
    throw ApiError.badRequest('请求体不能为空（可更新：done / dueAt）')
  }

  const data: { doneAt?: Date | null; dueAt?: Date | null } = {}
  if (body.done !== undefined) data.doneAt = body.done ? new Date() : null
  if (body.dueAt !== undefined) data.dueAt = body.dueAt ? new Date(body.dueAt) : null

  const updated = await prisma.todoItem.update({ where: { id }, data })
  return ok(updated, '待办已更新')
})

/**
 * DELETE /api/todos/:id —— 删除待办（删除工程第 5 棒）
 * 仅本人可删；logDelete 审计（todo.delete）。
 */
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  const existing = await prisma.todoItem.findUnique({
    where: { id },
    select: { id: true, userId: true, title: true, sourceType: true },
  })
  if (!existing) throw ApiError.notFound('待办不存在')
  if (existing.userId !== user.userId) throw ApiError.forbidden('无权删除他人的待办')

  await prisma.todoItem.delete({ where: { id } })

  await logDelete(user.userId, 'todo', id, {
    title: existing.title,
    sourceType: existing.sourceType,
  })

  return ok({ id }, '待办已删除')
})
