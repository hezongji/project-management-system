/**
 * DELETE /api/conversations/:id —— 解散会话（删除工程第 5 棒 · 消息域）
 *
 * 权限：仅群主（ConversationMember.role=OWNER 且 userId=本人）可解散，非群主 403。
 * 事务级联（物理删，Conversation 无 closed 软删字段）：
 *   1) 解除 Message 自引用（replyToId=null）→ 删除该会话全部 Message
 *   2) 删除该会话全部 ConversationMember
 *   3) 删除 Conversation 本体
 * logDelete 审计（conversation.delete）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params
  const user = requireAuth(request)
  const conversationId = id

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true, name: true, projectId: true },
  })
  if (!conversation) throw ApiError.notFound('会话不存在')

  // m6 修复：归档项目冻结检查——归档项目内会话不可解散（与「归档只读」口径一致）
  if (conversation.projectId) {
    const proj = await prisma.project.findUnique({
      where: { id: conversation.projectId },
      select: { isArchived: true },
    })
    if (proj?.isArchived) throw ApiError.forbidden('项目已归档（只读），不可解散会话')
  }

  // 群主校验：本人须为该会话 OWNER 成员
  const myMembership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.userId } },
    select: { role: true },
  })
  if (!myMembership || myMembership.role !== 'OWNER') {
    throw ApiError.forbidden('只有群主可以解散该会话')
  }

  // 事务级联：消息自引用解链 → 消息 → 成员 → 会话本体
  const result = await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({
      where: { conversationId, replyToId: { not: null } },
      data: { replyToId: null },
    })
    const messages = await tx.message.deleteMany({ where: { conversationId } })
    const members = await tx.conversationMember.deleteMany({ where: { conversationId } })
    await tx.conversation.delete({ where: { id: conversationId } })
    return { messages: messages.count, members: members.count }
  })

  await logDelete(user.userId, 'conversation', conversationId, {
    name: conversation.name,
    type: conversation.type,
    projectId: conversation.projectId,
    deletedMessages: result.messages,
    deletedMembers: result.members,
    action: 'dissolve',
  })

  return ok(result, '会话已解散')
})
