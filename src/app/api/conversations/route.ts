/**
 * /api/conversations —— 依据《开发文档-项目管理系统重构》§7.8（IM REST 补充）
 *
 * GET /api/conversations：我的会话列表（unread 计数 / lastMessage / 成员摘要）
 *   - 仅返回我所在的会话（members.some(userId)），按 lastMessageAt 倒序
 *   - unread = 会话内 createdAt > 我(lastReadAt ?? 0) 的消息数（含 SYSTEM；
 *     初始 lastReadAt=null → 全部消息计未读；POST /read 标读后清零）
 *   - lastMessage = 最新一条消息；members = 成员摘要（userId/name/email/avatar/role）
 *
 * 说明：发消息走 Socket message:send（§9.2），本 REST 仅查询；建群/欢迎消息由
 * phase-engine（P1-1）事务内落库并通过 PG NOTIFY im_events 推送（§9.4）。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const userId = user.userId

  const conversations = await prisma.conversation.findMany({
    where: { members: { some: { userId } } },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              // v1.2：聊天页标题显示部门（单聊「姓名+部门」）
              department: { select: { name: true } },
            },
          },
        },
      },
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: {
          sender: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
    },
  })

  // 未读统计（2026-08-22 P1-5 修复）：N 次 message.count → 1 次 groupBy 聚合
  // 注意：null lastReadAt = 从未读过 → 该会话全部消息计入；这里取会话级 lastReadAt 简化（与旧逻辑等价：null→全部计）
  const unreadMap = new Map<string, number>()
  if (conversations.length > 0) {
    // 每个会话对当前用户的 lastReadAt（来自成员关系）
    const readAtByConv = new Map<string, Date | null>()
    for (const c of conversations) {
      const myMember = c.members.find((m) => m.userId === userId)
      // v1.2 W1：unread cutoff = max(lastReadAt, hiddenAt)——删除会话期间的消息不计未读，
      // 新消息到达时前端会调 prefs 清除 hiddenAt（微信「删除后新消息自动复活」语义）
      let cutoff: Date | null = myMember?.lastReadAt ?? null
      if (myMember?.hiddenAt && (!cutoff || myMember.hiddenAt > cutoff)) {
        cutoff = myMember.hiddenAt
      }
      readAtByConv.set(c.id, cutoff)
    }
    // 批量拉取所有会话的消息 createdAt（仅取 lastReadAt 之后的计数）
    const groups = await prisma.message.groupBy({
      by: ['conversationId', 'createdAt'],
      where: {
        conversationId: { in: conversations.map((c) => c.id) },
      },
      _count: { _all: true },
    })
    // groupBy 无法在 where 里按每会话不同 lastReadAt 过滤，故拉全量后内存聚合（消息量小可接受）
    for (const g of groups) {
      const lastReadAt = readAtByConv.get(g.conversationId)
      if (lastReadAt && g.createdAt <= lastReadAt) continue
      unreadMap.set(g.conversationId, (unreadMap.get(g.conversationId) ?? 0) + g._count._all)
    }
  }

  const items = []
  for (const c of conversations) {
    const myMember = c.members.find((m) => m.userId === userId)
    const unread = unreadMap.get(c.id) ?? 0
    const lastMessage = c.messages[0] ?? null
    items.push({
      id: c.id,
      type: c.type,
      name: c.name,
      avatar: c.avatar,
      projectId: c.projectId,
      createdBy: c.createdBy,
      lastMessageAt: c.lastMessageAt,
      unread,
      myRole: myMember?.role ?? null,
      // v1.2 W1：会话偏好（置顶/免打扰/删除隐藏），W2/W3 依赖
      myPrefs: {
        isPinned: myMember?.isPinned ?? false,
        muted: myMember?.muted ?? false,
        hiddenAt: myMember?.hiddenAt?.toISOString() ?? null,
      },
      announcement: c.announcement ?? null,
      announcementAt: c.announcementAt?.toISOString() ?? null,
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            type: lastMessage.type,
            content: lastMessage.content,
            senderId: lastMessage.senderId,
            senderName: lastMessage.sender?.name ?? null,
            senderAvatar: lastMessage.sender?.avatar ?? null,
            revoked: lastMessage.revoked,
            createdAt: lastMessage.createdAt,
          }
        : null,
      members: c.members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        avatar: m.user.avatar,
        role: m.role,
        departmentName: m.user.department?.name ?? null,
      })),
    })
  }

  return ok(items)
})

// ───────────────────────────── POST：发起单聊 / 建群（P0-7）─────────────────────────────

const createConversationSchema = z.object({
  type: z.enum(['SINGLE', 'GROUP']),
  name: z.string().trim().max(100).nullable().optional(),
  memberIds: z.array(z.string().trim().min(1)).min(1, '请至少选择一位成员'),
})

/**
 * 事务内建会话 + 全部成员（创建者 OWNER，其余 MEMBER）+ PG NOTIFY conv:created。
 * NOTIFY 在事务提交时投递，im-server LISTEN 后推送新会话给成员并拉入房间（§9.4）。
 */
async function createConversation(
  me: string,
  type: 'SINGLE' | 'GROUP',
  name: string,
  otherIds: string[],
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { type, name, createdBy: me },
    })
    const memberRows = [
      { conversationId: conversation.id, userId: me, role: 'OWNER' as const },
      ...otherIds.map((id) => ({
        conversationId: conversation.id,
        userId: id,
        role: 'MEMBER' as const,
      })),
    ]
    await tx.conversationMember.createMany({ data: memberRows })

    await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'conv:created',
      conversation: {
        id: conversation.id,
        type,
        name,
        projectId: null,
        createdBy: me,
        members: [{ userId: me }, ...otherIds.map((id) => ({ userId: id }))],
      },
    })})`

    return { id: conversation.id }
  })
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const me = user.userId

  const body = createConversationSchema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )

  // 去重 + 排除自己
  const memberIds = Array.from(new Set(body.memberIds.filter((id) => id !== me)))
  if (memberIds.length === 0) {
    throw ApiError.badRequest('请至少选择一位其他成员')
  }

  // 校验所选成员存在且在职
  const users = await prisma.user.findMany({
    where: { id: { in: memberIds }, isActive: true },
    select: { id: true, name: true, email: true, avatar: true },
  })
  if (users.length !== memberIds.length) {
    throw ApiError.badRequest('部分成员不存在或已离职')
  }
  const userById = new Map(users.map((u) => [u.id, u]))

  const meInfo = await prisma.user.findUnique({
    where: { id: me },
    select: { id: true, name: true, email: true, avatar: true },
  })

  const memberSummary = (ids: string[]) => [
    ...(meInfo
      ? [
          {
            userId: meInfo.id,
            name: meInfo.name,
            email: meInfo.email,
            avatar: meInfo.avatar,
            role: 'OWNER',
          },
        ]
      : []),
    ...ids.map((id) => {
      const u = userById.get(id)!
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        avatar: u.avatar,
        role: 'MEMBER',
      }
    }),
  ]

  if (body.type === 'SINGLE') {
    if (memberIds.length !== 1) {
      throw ApiError.badRequest('单聊只能选择一位成员')
    }
    const other = userById.get(memberIds[0])!

    // 复用已有单聊：仅含我+对方两人的 SINGLE 会话
    const mySingles = await prisma.conversation.findMany({
      where: { type: 'SINGLE', members: { some: { userId: me } } },
      include: { members: { select: { userId: true } } },
    })
    const existing = mySingles.find(
      (c) =>
        c.members.length === 2 && c.members.some((m) => m.userId === other.id),
    )
    if (existing) {
      return ok(
        {
          id: existing.id,
          type: 'SINGLE',
          name: existing.name,
          reused: true,
          members: memberSummary([other.id]),
        },
        '已复用现有单聊',
      )
    }

    const name = body.name?.trim() || other.name
    const { id } = await createConversation(me, 'SINGLE', name, [other.id])
    return created(
      { id, type: 'SINGLE', name, reused: false, members: memberSummary([other.id]) },
      '单聊已创建',
    )
  }

  // GROUP
  const name = body.name?.trim() || '群聊'
  const { id } = await createConversation(me, 'GROUP', name, memberIds)
  return created(
    { id, type: 'GROUP', name, reused: false, members: memberSummary(memberIds) },
    '群聊已创建',
  )
})
