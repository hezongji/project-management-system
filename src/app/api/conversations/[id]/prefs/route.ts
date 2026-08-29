/**
 * /api/conversations/[id]/prefs —— 会话偏好（v1.2 W1）
 *
 * PATCH：置顶 / 免打扰 / 删除会话（本地隐藏）
 *   - userId 只取 token，不得来自 body（防越权改他人偏好）
 *   - hiddenAt 传 null 恢复显示（微信语义：删除后新消息自动复活）
 *   - 非会话成员 → 403（照抄 read 路由 catch→403 模式）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const userId = user.userId
  const conversationId = id

  const body = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const data: { isPinned?: boolean; muted?: boolean; hiddenAt?: Date | null } = {}
  if (typeof body.isPinned === 'boolean') data.isPinned = body.isPinned
  if (typeof body.muted === 'boolean') data.muted = body.muted
  if ('hiddenAt' in body) {
    const h = body.hiddenAt === null ? null : new Date(body.hiddenAt as string | number)
    if (h !== null && Number.isNaN(h.getTime())) throw ApiError.badRequest('hiddenAt 必须是合法时间或 null')
    data.hiddenAt = h
  }
  if (Object.keys(data).length === 0) throw ApiError.badRequest('无可更新的偏好字段')

  // 复合键定位本人成员行（userId 仅来自 token），非成员 updateMany 匹配 0 行 → 403
  const updated = await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data,
  })
  if (updated.count === 0) throw ApiError.forbidden('不是该会话成员')

  const me = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { isPinned: true, muted: true, hiddenAt: true },
  })

  return ok({
    conversationId,
    myPrefs: me ?? null,
  })
})
