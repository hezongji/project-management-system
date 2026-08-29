/**
 * POST /api/notifications/read-all —— 依据《开发文档-项目管理系统重构》§7.9
 *
 * 将当前用户全部通知标记为已读（isRead=true）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const result = await prisma.notification.updateMany({
    where: { userId: user.userId, isRead: false },
    data: { isRead: true },
  })

  return ok({ updated: result.count }, '全部已读')
})
