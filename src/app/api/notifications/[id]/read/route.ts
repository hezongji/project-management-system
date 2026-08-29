/**
 * PATCH /api/notifications/:id/read —— 依据《开发文档-项目管理系统重构》§7.9
 *
 * 将单条通知标记为已读（isRead=true），校验通知属于本人。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  const existing = await prisma.notification.findUnique({ where: { id } })
  if (!existing) throw ApiError.notFound('通知不存在')
  if (existing.userId !== user.userId) throw ApiError.forbidden('无权操作他人的通知')

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true },
  })
  return ok(updated, '已标记为已读')
})
