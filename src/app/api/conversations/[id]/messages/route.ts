/**
 * /api/conversations/[id]/messages —— 依据《开发文档-项目管理系统重构》§7.8
 *
 * GET ?before=&limit=50：历史消息（游标倒序分页）
 *   - 倒序返回（最新在前），游标 before = 上一页最旧一条消息的 id
 *   - 游标语义：取 createdAt 早于 before 消息（同毫秒按 id 次级排序去重）
 *   - 响应 data = { items, hasMore, nextBefore }；nextBefore 供下一页 before 参数
 *   - 非会话成员 → 403（§6.1 会话可见性底线：仅成员可读）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const userId = user.userId
  const conversationId = id

  // 成员校验（非成员不可读历史）
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { userId: true },
  })
  if (!member) throw ApiError.forbidden('不是该会话成员')

  const { searchParams } = new URL(request.url)
  const rawLimit = parseInt(searchParams.get('limit') || '50', 10)
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
  const beforeId = (searchParams.get('before') || '').trim() || null

  let beforeCreatedAt: Date | null = null
  if (beforeId) {
    const bm = await prisma.message.findUnique({
      where: { id: beforeId },
      select: { createdAt: true },
    })
    if (!bm) throw ApiError.badRequest(`before 游标消息不存在：${beforeId}`)
    beforeCreatedAt = bm.createdAt
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      ...(beforeCreatedAt
        ? {
            OR: [
              { createdAt: { lt: beforeCreatedAt } },
              { createdAt: beforeCreatedAt, id: { lt: beforeId as string } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1, // 多取一条判断是否还有更早
    include: {
      sender: { select: { id: true, name: true, email: true, avatar: true } },
    },
  })

  const hasMore = messages.length > limit
  const items = hasMore ? messages.slice(0, limit) : messages
  const nextBefore = items.length > 0 ? items[items.length - 1].id : null

  const normalized = items.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    sender: m.sender,
    type: m.type,
    content: m.content,
    replyToId: m.replyToId,
    fileMeta: m.fileMeta,
    mentions: m.mentions,
    revoked: m.revoked,
    createdAt: m.createdAt,
  }))

  return ok({ items: normalized, hasMore, nextBefore })
})
