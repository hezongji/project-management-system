/**
 * /api/projects/[id]/members/[memberId] —— 依据《开发文档-项目管理系统重构》§7.4（P0-8）
 *
 * DELETE：移除成员（memberId = 要移除成员的 userId）—— 项目 edit 权限；
 *         OWNER 角色成员不可移除（保证项目始终保留负责人）；
 *         同时从项目群会话（PROJECT_GROUP）移除 + 失效权限缓存。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidatePerms, invalidateProject } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; memberId: string }> }

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id, memberId } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const targetUserId = memberId

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: id, userId: targetUserId } },
    select: { userId: true, role: true },
  })
  if (!member) throw ApiError.notFound('该成员不在项目中')
  if (member.role === 'OWNER') {
    throw ApiError.badRequest('项目负责人（OWNER）不可移除')
  }

  await prisma.projectMember.delete({
    where: { projectId_userId: { projectId: id, userId: targetUserId } },
  })

  // 同步项目群会话：移除其成员身份
  const group = await prisma.conversation.findFirst({
    where: { projectId: id, type: 'PROJECT_GROUP' },
    select: { id: true },
  })
  if (group) {
    await prisma.conversationMember
      .deleteMany({
        where: { conversationId: group.id, userId: targetUserId },
      })
      .catch(() => ({ count: 0 }))
  }

  invalidatePerms(targetUserId)
  invalidateProject(id)

  return ok({ projectId: id, removedUserId: targetUserId }, '已移出项目')
})
