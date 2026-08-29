/**
 * DELETE /api/issues/:issueId —— 删除问题（删除工程第 6 棒 · 问题域）
 *
 * issueId = ISSUE 会话 id（Conversation.type='ISSUE'，schema 无独立 Issue 表，§7.8 映射）。
 *
 * 权限：上报人（Conversation.createdBy）或 ADMIN；其余 403。
 * 状态闸：OPEN（含详情消息缺失的退化情形）可删；已 RESOLVED → 400 保留处理闭环历史。
 * 关联任务解除：taskId 仅存于 ISSUE 详情消息 content 内，随消息删除自然解除关联；
 *             任务本体不删（留在项目售后阶段，由任务域另行处理）。
 * 事务级联（与会话解散同口径）：解链 Message.replyTo → 消息 → 成员 → 会话本体。
 * 审计：logDelete（issue.delete）。
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
  const issueId = id

  const conversation = await prisma.conversation.findUnique({
    where: { id: issueId },
    select: { id: true, type: true, name: true, projectId: true, createdBy: true },
  })
  if (!conversation || conversation.type !== 'ISSUE') {
    throw ApiError.notFound('问题会话不存在')
  }

  // 权限：上报人（createdBy 或首条 ISSUE 消息发送者，与前端 mine 口径对齐 m10）或 ADMIN；
  // 防御性成员校验（m12）：非 ADMIN 须为会话成员
  let issueSenderId: string | null = null
  if (conversation.createdBy !== user.userId && user.role !== 'ADMIN') {
    const firstIssueMsg = await prisma.message.findFirst({
      where: { conversationId: issueId, type: 'ISSUE' },
      orderBy: { createdAt: 'asc' },
      select: { senderId: true },
    })
    issueSenderId = firstIssueMsg?.senderId ?? null
    if (issueSenderId !== user.userId) {
      const member = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: { conversationId: issueId, userId: user.userId },
        },
        select: { id: true },
      })
      if (!member && conversation.createdBy !== user.userId) {
        throw ApiError.forbidden('仅上报人或管理员可删除该问题')
      }
    }
  }

  // 状态闸：读 ISSUE 详情消息（首条 type=ISSUE）的 status；RESOLVED 保留闭环历史
  const issueMessage = await prisma.message.findFirst({
    where: { conversationId: issueId, type: 'ISSUE' },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  })
  let content: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(issueMessage?.content ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      content = parsed as Record<string, unknown>
    }
  } catch {
    content = {}
  }
  const status = typeof content.status === 'string' ? content.status : 'OPEN'
  if (status === 'RESOLVED') {
    throw ApiError.badRequest('已解决的问题不可删除（保留处理闭环历史）')
  }

  // 事务级联：消息自引用解链 → 消息 → 成员 → 会话本体（关联任务不删，随消息删除解除关联）
  const result = await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({
      where: { conversationId: issueId, replyToId: { not: null } },
      data: { replyToId: null },
    })
    const messages = await tx.message.deleteMany({ where: { conversationId: issueId } })
    const members = await tx.conversationMember.deleteMany({ where: { conversationId: issueId } })
    await tx.conversation.delete({ where: { id: issueId } })
    return { messages: messages.count, members: members.count }
  })

  await logDelete(
    user.userId,
    'issue',
    issueId,
    {
      name: conversation.name,
      projectId: conversation.projectId,
      reporterId: conversation.createdBy,
      taskId: typeof content.taskId === 'string' ? content.taskId : null,
      deletedMessages: result.messages,
      deletedMembers: result.members,
    },
    conversation.projectId,
  )

  return ok({ issueId, ...result }, '问题已删除')
})
