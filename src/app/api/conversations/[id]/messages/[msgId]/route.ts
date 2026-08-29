/**
 * DELETE /api/conversations/:id/messages/:msgId —— 消息删除/撤回（删除工程第 5 棒 · 消息域）
 *
 * 权限：仅发送者本人（message.senderId===authUser.userId），非本人 403；
 *       非会话成员 403（沿用 GET 历史消息的成员可见性底线）。
 *
 * 删除口径：软删 revoked=true —— Message 无 deletedAt，但既有 revoked 字段即系统撤回
 * 标志（Socket.IO message:revoke 同款语义、GET 响应与气泡灰条均消费），且物理删会让
 * replyToId 自引用悬空，故统一走 revoked 软删。幂等：已撤回消息重复删除直接返回成功。
 * logDelete 审计（message.delete）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; msgId: string }> }

export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id: conversationId, msgId } = await context.params

  // 成员可见性底线（与 GET /messages 同口径）
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.userId } },
    select: { userId: true },
  })
  if (!member) throw ApiError.forbidden('不是该会话成员')

  // m6 修复：归档项目冻结检查——归档项目内消息不可删除/撤回
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { projectId: true },
  })
  if (conv?.projectId) {
    const proj = await prisma.project.findUnique({
      where: { id: conv.projectId },
      select: { isArchived: true },
    })
    if (proj?.isArchived) throw ApiError.forbidden('项目已归档（只读），不可删除消息')
  }

  const message = await prisma.message.findUnique({
    where: { id: msgId },
    select: { id: true, conversationId: true, senderId: true, type: true, revoked: true },
  })
  if (!message || message.conversationId !== conversationId) {
    throw ApiError.notFound('消息不存在')
  }
  if (message.senderId !== user.userId) throw ApiError.forbidden('只有发送者本人可以删除该消息')

  // 幂等：已撤回无需重复处理
  if (message.revoked) {
    return ok({ id: msgId, revoked: true }, '消息已删除')
  }

  const updated = await prisma.message.update({
    where: { id: msgId },
    data: { revoked: true },
    select: { id: true, conversationId: true, senderId: true, revoked: true },
  })

  await logDelete(user.userId, 'message', msgId, {
    conversationId,
    type: message.type,
    mode: 'revoke',
  })

  return ok(updated, '消息已删除')
})
