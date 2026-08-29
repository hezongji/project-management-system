/**
 * /api/tasks/[id]/comments —— 依据《开发文档-项目管理系统重构》§7.6 / §7.9 / §5 Comment
 *
 * GET   任务 view   评论列表（createdAt 正序分页）
 * POST  任务 view   发表评论 body { content, mentions?: string[] }
 *        mentions（@联想产生）→ 对每个被@用户：
 *          ① Notification(type=MENTION, link 跳任务抽屉)
 *          ② TodoItem(sourceType=TASK, sourceId=taskId, dueAt=任务截止日, priority=任务优先级)
 *        （§7.9「mentions 自动→通知+待办」）
 *        自己 @ 自己过滤；mention 用户不存在/离职 → 400。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  okPage,
  created,
  parsePagination,
  requireAuth,
  ApiError,
} from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { EngineError } from '@/lib/phase-engine'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

// ───────────────────────────── GET：评论列表 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'view', { type: 'TASK', id })

  const { page, limit, skip } = parsePagination(request, 50)
  const where = { taskId: id }
  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, avatar: true } } },
      skip,
      take: limit,
    }),
    prisma.comment.count({ where }),
  ])

  return okPage(comments, page, limit, total)
})

// ───────────────────────────── POST：发表评论（mentions→通知+待办） ─────────────────────────────

const createSchema = z
  .object({
    content: z.string().min(1, '评论内容不能为空').max(2000, '评论不超过 2000 字'),
    mentions: z.array(z.string()).max(50).optional(),
  })
  .strict()

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'view', { type: 'TASK', id })

  const body = createSchema.parse(await request.json())

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        projectId: true,
        priority: true,
        dueDate: true,
        project: { select: { code: true, name: true } },
      },
    })
    if (!task) throw new EngineError(404, '任务不存在', 'NOT_FOUND')

    // mentions 去重 + 过滤自己 + 存在性校验
    const seen = new Set<string>()
    const mentionIds = (body.mentions ?? []).filter((uid) => {
      if (!uid || uid === user.userId || seen.has(uid)) return false
      seen.add(uid)
      return true
    })

    if (mentionIds.length > 0) {
      const users = await tx.user.findMany({
        where: { id: { in: mentionIds } },
        select: { id: true, isActive: true },
      })
      const found = new Set(users.filter((u) => u.isActive).map((u) => u.id))
      const missing = mentionIds.filter((uid) => !found.has(uid))
      if (missing.length > 0) {
        throw new EngineError(400, `mentions 中存在无效用户：${missing.join(', ')}`)
      }
    }

    const comment = await tx.comment.create({
      data: {
        taskId: task.id,
        userId: user.userId,
        content: body.content.trim(),
        mentions: mentionIds as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
      include: { user: { select: { id: true, name: true, avatar: true } } },
    })

    // §7.9：mentions → 通知 + 待办
    const link = `/projects/${task.projectId}/tasks/${task.id}`
    const contentPreview =
      body.content.length > 50 ? `${body.content.slice(0, 50)}…` : body.content
    const me = await tx.user.findUnique({
      where: { id: user.userId },
      select: { name: true },
    })
    for (const uid of mentionIds) {
      await tx.notification.create({
        data: {
          userId: uid,
          type: 'MENTION',
          title: `${me?.name ?? '同事'}在任务「${task.title}」中提到了你`,
          body: contentPreview,
          link,
        },
      })
      await tx.todoItem.create({
        data: {
          userId: uid,
          title: `【提到我】${task.title}`,
          sourceType: 'TASK',
          sourceId: task.id,
          link,
          dueAt: task.dueDate,
          priority: task.priority,
        },
      })
    }

    return { comment, mentionIds, taskCode: task.project.code }
  })

  return created(
    { ...result.comment, notified: result.mentionIds },
    result.mentionIds.length > 0
      ? `评论已发表，已通知 ${result.mentionIds.length} 位被@成员`
      : '评论已发表',
  )
})
