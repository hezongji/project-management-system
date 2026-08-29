import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'

/**
 * /api/urges/mine —— 我的催办（2026-08-22 工作台「我的催办」卡片）
 *
 * GET /api/urges/mine → {
 *   incoming: 别人催办我的（ACTIVE 未处理，按时间倒序）
 *   incomingCount, incomingDoneCount,
 *   outgoing: 我催办别人的（ACTIVE + 最近 DONE）
 *   outgoingCount,
 *   recentlyDone: 最近已处理（被催人已提交，供闭环展示）
 * }
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const limit = Math.min(Number(searchParams.get('limit') ?? 20), 50)

  // 别人催办我的（未处理）
  const [incoming, incomingDone, outgoing, outgoingDone] = await Promise.all([
    prisma.urgeRecord.findMany({
      where: { targetUserId: user.userId, status: 'ACTIVE' },
      include: {
        urgedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.urgeRecord.count({
      where: { targetUserId: user.userId, status: 'DONE' },
    }),
    prisma.urgeRecord.findMany({
      where: { urgedById: user.userId, status: 'ACTIVE' },
      include: {
        targetUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.urgeRecord.count({
      where: { urgedById: user.userId, status: 'DONE' },
    }),
  ])

  // 最近已处理的催办（被催人已提交，闭环展示前 5 条）
  const recentlyDone = await prisma.urgeRecord.findMany({
    where: { targetUserId: user.userId, status: 'DONE' },
    include: {
      urgedBy: { select: { id: true, name: true } },
    },
    orderBy: { doneAt: 'desc' },
    take: 5,
  })

  return ok({
    incoming,
    incomingCount: incoming.length,
    incomingDoneCount: incomingDone,
    outgoing,
    outgoingCount: outgoing.length,
    outgoingDoneCount: outgoingDone,
    recentlyDone,
  })
})
