/**
 * /api/conversations/[id]/announcement —— 群公告（v1.2 W1）
 *
 * PATCH：发布/更新公告（仅会话 OWNER/ADMIN，requireManageRole 照抄 members 路由）
 *   - 事务内：写 announcement/announcementAt + SYSTEM 消息「群公告已更新」+ touch lastMessageAt
 *     + pg_notify im_events message:new（im-server 广播 → 会话列表实时刷新）
 *   - content 传空字符串 → 清除公告
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** 断言当前用户是该会话 OWNER/ADMIN（否则 403，照抄 members 路由） */
async function requireManageRole(conversationId: string, userId: string) {
  const me = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { role: true },
  })
  if (!me) throw ApiError.forbidden('不是该会话成员')
  if (me.role !== 'OWNER' && me.role !== 'ADMIN') {
    throw ApiError.forbidden('仅会话 OWNER/ADMIN 可管理成员')
  }
  return me
}

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const conversationId = id

  const body = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (content.length > 2000) throw ApiError.badRequest('公告内容不能超过 2000 字')

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  })
  if (!conversation) throw ApiError.notFound('会话不存在')

  await requireManageRole(conversationId, user.userId)

  const now = new Date()
  const announcement = content === '' ? null : content

  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        announcement,
        announcementAt: announcement ? now : null,
        lastMessageAt: now,
      },
    })
    // 系统消息入会话（成员可见「群公告已更新」），照抄 issues/reports 的 SYSTEM 消息模式
    await tx.message.create({
      data: {
        conversationId,
        senderId: user.userId,
        type: 'SYSTEM',
        content: announcement ? '群公告已更新' : '群公告已清除',
      },
    })
    // PG NOTIFY im_events message:new（事务提交时投递）：会话列表实时刷新
    await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'message:new',
      conversationId,
    })})`
  })

  return ok({ conversationId, announcement, announcementAt: announcement ? now.toISOString() : null })
})
