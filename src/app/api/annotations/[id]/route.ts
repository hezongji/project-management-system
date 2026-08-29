/**
 * /api/annotations/[id] —— 依据《开发文档-项目管理系统重构》§7.6
 *
 * PATCH  本人 / 任务 edit   解决标注（resolved），也可修改 note/color：
 *        - resolved: boolean（§7.6 主用途）
 *        - note / color：编辑自己的便签内容
 * 权限：标注本人可操作自己的标注；任务 edit（assignee/创建人/上级负责人/ADMIN）可解决任意标注。
 *
 * DELETE 删除工程第 3 棒（设计方案-删除与垃圾清理 §2/§4-D4）：
 *        作者本人 或 可见范围内 PM（项目 OWNER/MANAGER）/ADMIN；直接删除 + logDelete 审计。
 * 双闸：① visibleTaskFilter 任务不可见 → 404（不暴露存在）；② 作者/PM/ADMIN → 403。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { can } from '@/lib/permission'
import { visibleTaskFilter } from '@/lib/data-visibility'
import { logDelete } from '@/lib/delete-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const patchSchema = z
  .object({
    resolved: z.boolean().optional(),
    note: z.string().min(1).max(500).optional(),
    color: z.enum(['yellow', 'red', 'blue', 'green']).optional(),
  })
  .strict()

export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  const body = patchSchema.parse(await request.json())
  if (Object.keys(body).length === 0) {
    throw ApiError.badRequest('请求体不能为空（可更新：resolved/note/color）')
  }

  const updated = await prisma.$transaction(async (tx) => {
    const annotation = await tx.annotation.findUnique({
      where: { id },
      select: { id: true, taskId: true, userId: true, resolved: true },
    })
    if (!annotation) throw ApiError.notFound('标注不存在')

    // 本人 或 任务 edit（§7.6「本人/任务 edit 解决」）
    const isOwner = annotation.userId === user.userId
    const canEditTask = await can(user.userId, 'edit', {
      type: 'TASK',
      id: annotation.taskId,
    })
    if (!isOwner && !canEditTask) {
      throw ApiError.forbidden('只有标注本人或任务编辑者可以操作该标注')
    }

    return tx.annotation.update({
      where: { id: annotation.id },
      data: {
        ...(body.resolved !== undefined && { resolved: body.resolved }),
        ...(body.note !== undefined && { note: body.note.trim() }),
        ...(body.color !== undefined && { color: body.color }),
      },
      include: { user: { select: { id: true, name: true, avatar: true } } },
    })
  })

  return ok(updated, body.resolved === false ? '标注已重新打开' : '标注已更新')
})

// ───────────────────── DELETE：删除标注（删除工程第 3 棒，D4）─────────────────────

export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  // 双闸①：可见性 —— 标注所属任务不在可见范围 → 404（不暴露存在，§2 铁律 1）
  const visFilter = await visibleTaskFilter(user.userId, user.role)
  const annotation = await prisma.annotation.findFirst({
    where: { id, task: visFilter },
    select: {
      id: true,
      taskId: true,
      userId: true,
      field: true,
      note: true,
      task: { select: { projectId: true, project: { select: { isArchived: true } } } },
    },
  })
  if (!annotation) throw ApiError.notFound('标注不存在')

  // 双闸②：权限 —— 作者本人 或 可见范围内 PM（项目 OWNER/MANAGER）/ADMIN（D4+任务书）
  const isOwner = annotation.userId === user.userId
  let isPmOrAdmin = user.role === 'ADMIN'
  if (!isPmOrAdmin) {
    const member = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: annotation.task.projectId, userId: user.userId },
      },
      select: { role: true },
    })
    isPmOrAdmin = member?.role === 'OWNER' || member?.role === 'MANAGER'
  }
  if (!isOwner && !isPmOrAdmin) {
    throw ApiError.forbidden('仅标注作者或项目经理（OWNER/MANAGER）/管理员可删除标注')
  }

  // 归档项目冻结（只读，删除工程既有口径，需先解除归档）
  if (annotation.task.project.isArchived) {
    throw ApiError.forbidden('项目已归档（只读），请先解除归档后再删除')
  }

  await prisma.annotation.delete({ where: { id: annotation.id } })
  await logDelete(
    user.userId,
    'annotation',
    annotation.id,
    {
      taskId: annotation.taskId,
      projectId: annotation.task.projectId,
      field: annotation.field,
      notePreview:
        annotation.note.length > 50
          ? `${annotation.note.slice(0, 50)}…`
          : annotation.note,
    },
    annotation.task.projectId,
  )

  return ok({ deleted: true, id: annotation.id }, '标注已删除')
})
