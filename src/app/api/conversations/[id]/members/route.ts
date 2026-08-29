/**
 * /api/conversations/[id]/members —— 依据《开发文档-项目管理系统重构》§7.8（P0-7）
 *
 * POST：拉人（{ userIds: [] }）—— 仅会话 OWNER/ADMIN；已存在成员自动跳过；
 *       落库后 PG NOTIFY conv:created（members=新加入者），im-server 推送并拉入房间。
 * DELETE：踢人走 /api/conversations/[id]/members/[memberId]（仅 OWNER/ADMIN）。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** 断言当前用户是该会话 OWNER/ADMIN（否则 403） */
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

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  const conversationId = id

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true, name: true, projectId: true, createdBy: true },
  })
  if (!conversation) throw ApiError.notFound('会话不存在')

  await requireManageRole(conversationId, user.userId)

  const schema = z.object({
    userIds: z.array(z.string().trim().min(1)).min(1, '请至少选择一位成员'),
  })
  const { userIds } = schema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )

  const unique = Array.from(new Set(userIds))
  const users = await prisma.user.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true },
  })
  if (users.length !== unique.length) {
    throw ApiError.badRequest('部分成员不存在或已离职')
  }

  // 已存在成员跳过
  const existingRows = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { in: unique } },
    select: { userId: true },
  })
  const existingIds = new Set(existingRows.map((m) => m.userId))
  const toAdd = unique.filter((id) => !existingIds.has(id))

  if (toAdd.length > 0) {
    await prisma.conversationMember.createMany({
      data: toAdd.map((id) => ({
        conversationId,
        userId: id,
        role: 'MEMBER',
      })),
    })
    // §9.4：NOTIFY conv:created（仅新成员），im-server 推送 + 拉入房间
    await prisma.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'conv:created',
      conversation: {
        id: conversationId,
        type: conversation.type,
        name: conversation.name,
        projectId: conversation.projectId,
        createdBy: conversation.createdBy,
        members: toAdd.map((id) => ({ userId: id })),
      },
    })})`
  }

  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    include: {
      user: { select: { id: true, name: true, email: true, avatar: true } },
    },
  })

  return ok(
    {
      added: toAdd.length,
      members: members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        avatar: m.user.avatar,
        role: m.role,
      })),
    },
    toAdd.length > 0 ? `已拉入 ${toAdd.length} 人` : '无新增成员',
  )
})
