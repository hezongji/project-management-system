/**
 * DELETE /api/urges/:id —— 删除催办记录（删除工程第 5 棒 · 消息域）
 *
 * 权限：仅发起人（urgeRecord.urgedById===authUser.userId，schema 字段为 urgedById
 * 而非 senderId），被催人/他人 403。
 * logDelete 审计（urge.delete）。
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

  const existing = await prisma.urgeRecord.findUnique({
    where: { id },
    select: {
      id: true,
      urgedById: true,
      targetUserId: true,
      projectCode: true,
      requirementName: true,
      status: true,
    },
  })
  if (!existing) throw ApiError.notFound('催办记录不存在')
  if (existing.urgedById !== user.userId) throw ApiError.forbidden('只有催办发起人可以删除该记录')

  await prisma.urgeRecord.delete({ where: { id } })

  await logDelete(user.userId, 'urge', id, {
    projectCode: existing.projectCode,
    requirementName: existing.requirementName,
    targetUserId: existing.targetUserId,
    status: existing.status,
  })

  return ok({ id }, '催办记录已删除')
})
