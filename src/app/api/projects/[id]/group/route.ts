/**
 * POST /api/projects/:id/group —— 确保项目群存在（v1.2 owner：点项目直接进项目群聊）
 *
 * 找到或创建 type='PROJECT_GROUP' 的会话（成员=当前项目成员），返回 conversationId。
 * 用于 App「项目」Tab：点项目 → 进项目群（无群则自动创建）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id })

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } })
  if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 })

  // 已有项目群 → 直接返回
  const existing = await prisma.conversation.findFirst({
    where: { projectId: id, type: 'PROJECT_GROUP' },
    select: { id: true },
  })
  if (existing) return ok({ conversationId: existing.id, created: false })

  // 项目成员（当前所有成员）
  const memberIds = (
    await prisma.projectMember.findMany({
      where: { projectId: id },
      select: { userId: true },
    })
  ).map((m) => m.userId)

  // 无群 → 创建 PROJECT_GROUP + 拉入全部成员 + 系统欢迎消息 + NOTIFY
  const result = await prisma.$transaction(async (tx) => {
    const conv = await tx.conversation.create({
      data: {
        type: 'PROJECT_GROUP',
        name: project.name,
        projectId: id,
        createdBy: user.userId,
        lastMessageAt: new Date(),
        members: {
          create: Array.from(new Set([...memberIds, user.userId])).map((uid) => ({
            userId: uid,
            role: 'MEMBER',
          })),
        },
      },
    })
    await tx.message.create({
      data: {
        conversationId: conv.id,
        senderId: user.userId,
        type: 'SYSTEM',
        content: '项目群已创建，成员为当前项目成员',
      },
    })
    return conv
  })

  await prisma.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
    event: 'conv:created',
    conversation: { id: result.id, type: 'PROJECT_GROUP', projectId: id },
  })})`

  return ok({ conversationId: result.id, created: true })
})
