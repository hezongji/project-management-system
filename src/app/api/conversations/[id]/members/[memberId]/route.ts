/**
 * /api/conversations/[id]/members/[memberId] —— 依据《开发文档-项目管理系统重构》§7.8（P0-7）
 *
 * DELETE：踢人（memberId = 要移除成员的 userId）—— 仅会话 OWNER/ADMIN；
 *         不能移除自己；不产生额外 NOTIFY（被移除者下次连接时按 DB 恢复订阅自然失联）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; memberId: string }> }

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id, memberId } = await params
  const user = requireAuth(request)
  const conversationId = id
  const targetUserId = memberId

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  })
  if (!conversation) throw ApiError.notFound('会话不存在')

  const me = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.userId } },
    select: { role: true },
  })
  if (!me) throw ApiError.forbidden('不是该会话成员')
  if (me.role !== 'OWNER' && me.role !== 'ADMIN') {
    throw ApiError.forbidden('仅会话 OWNER/ADMIN 可管理成员')
  }
  if (targetUserId === user.userId) {
    throw ApiError.badRequest('不能移除自己')
  }

  const target = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    select: { userId: true },
  })
  if (!target) throw ApiError.notFound('该成员不在会话中')

  await prisma.conversationMember.delete({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  })

  return ok({ conversationId, removedUserId: targetUserId }, '已移出会话')
})
