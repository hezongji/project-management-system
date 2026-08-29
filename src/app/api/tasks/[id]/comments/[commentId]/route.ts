/**
 * /api/tasks/[id]/comments/[commentId] —— 删除工程第 3 棒（设计方案-删除与垃圾清理 §2/§4-D5）
 *
 * DELETE  作者本人 或 可见范围内 PM（项目 OWNER/MANAGER）/ADMIN：
 *         直接删除 + logDelete 审计；归档项目冻结不可删。
 * 双闸：① visibleTaskFilter 任务不可见 → 404（不暴露存在；commentId 不属于该任务同样 404）
 *       ② 作者/PM/ADMIN → 403。
 * 说明：评论 mentions 生成的通知/待办指向任务抽屉（非评论本体），按 D5「直接删」保留不级联。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { visibleTaskFilter } from '@/lib/data-visibility'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; commentId: string }> }

export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id, commentId } = await context.params

  // 双闸①：可见性 —— 任务不可见或评论不属于该任务 → 404（不暴露存在，§2 铁律 1）
  const visFilter = await visibleTaskFilter(user.userId, user.role)
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, taskId: id, task: visFilter },
    select: {
      id: true,
      taskId: true,
      userId: true,
      content: true,
      mentions: true,
      task: {
        select: { projectId: true, title: true, project: { select: { isArchived: true } } },
      },
    },
  })
  if (!comment) throw ApiError.notFound('评论不存在')

  // 双闸②：权限 —— 作者本人 或 可见范围内 PM（项目 OWNER/MANAGER）/ADMIN（D5+任务书）
  const isOwner = comment.userId === user.userId
  let isPmOrAdmin = user.role === 'ADMIN'
  if (!isPmOrAdmin) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: comment.task.projectId, userId: user.userId } },
      select: { role: true },
    })
    isPmOrAdmin = member?.role === 'OWNER' || member?.role === 'MANAGER'
  }
  if (!isOwner && !isPmOrAdmin) {
    throw ApiError.forbidden('仅评论作者或项目经理（OWNER/MANAGER）/管理员可删除评论')
  }

  // 归档项目冻结（只读，删除工程既有口径，需先解除归档）
  if (comment.task.project.isArchived) {
    throw ApiError.forbidden('项目已归档（只读），请先解除归档后再删除')
  }

  await prisma.comment.delete({ where: { id: comment.id } })
  await logDelete(
    user.userId,
    'comment',
    comment.id,
    {
      taskId: comment.taskId,
      taskTitle: comment.task.title,
      projectId: comment.task.projectId,
      contentPreview:
        comment.content.length > 50 ? `${comment.content.slice(0, 50)}…` : comment.content,
      ...(comment.mentions ? { mentions: comment.mentions } : {}),
    },
    comment.task.projectId,
  )

  return ok({ deleted: true, id: comment.id }, '评论已删除')
})
