/**
 * DELETE /api/notifications/:id —— 删除单条通知（删除工程第 5 棒 · 消息域）
 *
 * 权限：仅本人（notification.userId===authUser.userId），他人通知 403。
 * logDelete 审计（notification.delete）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  const existing = await prisma.notification.findUnique({
    where: { id },
    select: { id: true, userId: true, type: true, title: true, isRead: true },
  })
  if (!existing) throw ApiError.notFound('通知不存在')
  if (existing.userId !== user.userId) throw ApiError.forbidden('无权删除他人的通知')

  await prisma.notification.delete({ where: { id } })

  await logDelete(user.userId, 'notification', id, {
    type: existing.type,
    title: existing.title,
    isRead: existing.isRead,
  })

  return ok({ id }, '通知已删除')
})
