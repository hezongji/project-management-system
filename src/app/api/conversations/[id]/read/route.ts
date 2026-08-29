/**
 * /api/conversations/[id]/read —— 依据《开发文档-项目管理系统重构》§7.8
 *
 * POST：标读 lastReadAt = now（§7.8「POST /conversations/:id/read」）
 *   - 写库后按 §9.4 通过 PG NOTIFY im_events 推送 read:sync（§9.2 S→C），
 *     im-server LISTEN 后广播该会话的已读同步（userIds=[本人]）
 *   - 非会话成员 → 403
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const userId = user.userId
  const conversationId = id

  const now = new Date()

  const updated = await prisma.conversationMember
    .update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: now },
    })
    .catch(() => null)
  if (!updated) throw ApiError.forbidden('不是该会话成员')

  // §9.4 写库后 NOTIFY：read:sync（实时已读同步，由 im-server 广播到会话房间）
  await prisma.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
    event: 'read:sync',
    conversationId,
    userId,
    lastReadAt: now.toISOString(),
  })})`

  return ok({
    conversationId,
    userId,
    lastReadAt: now.toISOString(),
  })
})
