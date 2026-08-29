/**
 * PATCH /api/issues/:issueId/resolve —— 依据《开发文档-项目管理系统重构》§7.8
 *
 * 问题处理闭环：{ solution }
 *   issueId = ISSUE 会话的 id（Conversation.type='ISSUE'）
 *   → 详情消息 status 改 RESOLVED + 附加 solution + 关联任务 DONE + 通知上报人
 *
 * 关键设计决策（无独立 Issue 表）：
 *   - 关联任务靠「同项目 + title 匹配」（建任务时 title=问题标题，会话 name=问题标题）
 *   - 上报人 = 会话 createdBy
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const resolveSchema = z.object({
  solution: z.string().trim().min(1, '处理方案不能为空'),
})

export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params
  const user = requireAuth(request)
  const userId = user.userId
  const issueId = id

  const body = resolveSchema.parse(await request.json())

  const result = await prisma.$transaction(
    async (tx) => {
      // ── 动作①：找 ISSUE 会话，不存在 → 404 ──
      const conversation = await tx.conversation.findUnique({
        where: { id: issueId },
        select: { id: true, type: true, name: true, projectId: true, createdBy: true },
      })
      if (!conversation || conversation.type !== 'ISSUE') {
        throw ApiError.notFound('问题会话不存在')
      }

      // ── 动作②：校验当前用户是其成员 → 否则 403 ──
      const member = await tx.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: issueId, userId } },
      })
      if (!member) {
        throw ApiError.forbidden('你不是该问题会话的成员，无权处理')
      }

      // ── 动作③：找该会话的 ISSUE 消息，content 改 status=RESOLVED + solution ──
      const issueMessage = await tx.message.findFirst({
        where: { conversationId: issueId, type: 'ISSUE' },
        orderBy: { createdAt: 'asc' },
      })
      if (!issueMessage) throw ApiError.notFound('问题详情消息不存在')

      let content: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(issueMessage.content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          content = parsed as Record<string, unknown>
        }
      } catch {
        content = {}
      }
      content.status = 'RESOLVED'
      content.solution = body.solution
      content.resolvedBy = userId
      content.resolvedAt = new Date().toISOString()

      await tx.message.update({
        where: { id: issueMessage.id },
        data: { content: JSON.stringify(content) },
      })

      // ── 动作④：关闭关联任务（优先用 ISSUE 消息已存 taskId，缺失/失效时 title 匹配兜底）──
      const projectId = conversation.projectId
      let task: { id: string } | null = null
      const taskId = typeof content.taskId === 'string' && content.taskId ? content.taskId : null

      if (taskId) {
        // 优先：用 POST /issues 建任务时写入的 taskId 精确定位（避免同名任务误关/漏关）
        try {
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'DONE', completedAt: new Date() },
          })
          task = { id: taskId }
        } catch {
          // 任务可能已被删除/不存在 → 降级到 title 匹配兜底
          task = null
        }
      }

      if (!task && projectId) {
        task = await tx.task.findFirst({
          where: {
            projectId,
            title: conversation.name ?? '',
            status: { not: 'DONE' },
          },
          select: { id: true },
        })
        if (task) {
          await tx.task.update({
            where: { id: task.id },
            data: { status: 'DONE', completedAt: new Date() },
          })
        }
      }

      // ── 动作⑤：建通知 ISSUE_RESOLVED（上报人 = 会话 createdBy）──
      const reporterId = conversation.createdBy
      if (reporterId) {
        await tx.notification.create({
          data: {
            userId: reporterId,
            type: 'ISSUE_RESOLVED',
            title: `问题已处理：${conversation.name ?? ''}`,
            body: `处理方案：${body.solution}`,
            link: `/messages?conversation=${issueId}`,
          },
        })
      }

      // ── 动作⑥：PG NOTIFY（§9.4）──
      // ① message:new：广播更新后的 ISSUE 消息
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'message:new',
        conversationId: issueId,
      })})`
      // ② notify:push：实时通知上报人
      if (reporterId) {
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'notify:push',
          userId: reporterId,
          title: `问题已处理：${conversation.name ?? ''}`,
          body: `处理方案：${body.solution}`,
          link: `/messages?conversation=${issueId}`,
        })})`
      }

      return { issueId, status: 'RESOLVED' as const, taskId: task?.id ?? null }
    },
    { timeout: 30_000 }
  )

  return ok(
    { issueId: result.issueId, status: result.status, taskId: result.taskId },
    '问题已处理闭环'
  )
})
