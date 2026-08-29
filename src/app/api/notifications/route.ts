/**
 * /api/notifications —— 依据《开发文档-项目管理系统重构》§7.9 / §8.3「通知中心」
 *
 * GET /api/notifications?unread=1&page=&limit=  当前用户通知
 *   - unread=1：仅未读（isRead=false）
 *   - 按 createdAt 倒序分页（§4 分页约定，data = { items, pagination }）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, okPage, requireAuth, parsePagination } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { page, limit, skip } = parsePagination(request, 20)
  const { searchParams } = new URL(request.url)
  const unreadOnly =
    searchParams.get('unread') === '1' || searchParams.get('unread') === 'true'

  const where = {
    userId: user.userId,
    ...(unreadOnly ? { isRead: false } : {}),
  }

  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where }),
  ])

  return okPage(items, page, limit, total)
})
