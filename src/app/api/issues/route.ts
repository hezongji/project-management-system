/**
 * /api/issues —— 依据《开发文档-项目管理系统重构》§7.8 / §9.3
 *
 * POST /api/issues  问题上报 { title, urgency, projectId, desc, images[], assigneeId }
 *   → 生成 ISSUE 会话 + 任务(PH19 售后或指定阶段) + 通知
 *
 * 关键设计决策（schema 无独立 Issue 表，按 §7.8 映射，勿擅自加表/migrate）：
 *   - issueId = ISSUE 会话的 id（Conversation.type='ISSUE'）；PATCH /issues/:id/resolve
 *     的 issueId 即 conversation.id
 *   - 会话：Conversation { type:'ISSUE', name:<标题>, projectId, createdBy:<上报人>,
 *     members:[上报人, assigneeId?, 项目OWNER?] 去重 }
 *   - 详情消息：Message { type:'ISSUE', content: JSON.stringify(§9.3 卡片) }
 *   - 关联任务：Task { projectId, phaseId:<PH19 售后阶段>, title, priority:<urgency 映射>,
 *     assigneeId }
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

// urgency → task.priority 映射（HIGH→HIGH、MEDIUM→MEDIUM、LOW→LOW；§7.8）
const URGENCY_TO_PRIORITY = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const

type Urgency = keyof typeof URGENCY_TO_PRIORITY

const createIssueSchema = z.object({
  title: z.string().trim().min(1, '问题标题不能为空').max(200),
  projectId: z.string().min(1, '项目ID不能为空'),
  urgency: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  desc: z.string().optional(),
  images: z.array(z.string()).optional(),
  assigneeId: z.string().optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const userId = user.userId

  const body = createIssueSchema.parse(await request.json())
  const urgency: Urgency = body.urgency

  // 项目 view 权限（§6.1 基线：项目成员可 view；ADMIN 直通；非成员 403）
  await requireCan(userId, 'view', { type: 'PROJECT', id: body.projectId })

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, name: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw new ApiError(403, '项目已归档，无法上报问题')

  // assigneeId 校验（可选）
  if (body.assigneeId) {
    const target = await prisma.user.findUnique({
      where: { id: body.assigneeId },
      select: { id: true, isActive: true },
    })
    if (!target || !target.isActive) {
      throw ApiError.badRequest(`指派对象不存在或已离职：${body.assigneeId}`)
    }
  }

  const result = await prisma.$transaction(
    async (tx) => {
      // ── 动作①：找 PH19 售后阶段；找不到则 phaseId=null（任务挂项目下，无阶段）──
      const phase19 = await tx.phase.findFirst({
        where: { projectId: body.projectId, code: 'PH19' },
        select: { id: true },
      })

      // 项目 OWNER（通知兜底对象 + 会话成员）
      const projectOwner = await tx.projectMember.findFirst({
        where: { projectId: body.projectId, role: 'OWNER' },
        select: { userId: true },
      })

      // ── 动作②：建 Task ──
      const task = await tx.task.create({
        data: {
          projectId: body.projectId,
          phaseId: phase19?.id ?? null,
          title: body.title,
          description: body.desc ?? null,
          status: 'TODO',
          priority: URGENCY_TO_PRIORITY[urgency],
          assigneeId: body.assigneeId ?? null,
          creatorId: userId,
        },
      })

      // ── 动作③：建 ISSUE 会话 ──
      const conversation = await tx.conversation.create({
        data: {
          type: 'ISSUE',
          name: body.title,
          projectId: body.projectId,
          createdBy: userId,
        },
      })

      // members 去重：[上报人, assigneeId?, 项目OWNER?]
      const memberIds = Array.from(
        new Set([userId, body.assigneeId, projectOwner?.userId].filter(Boolean) as string[])
      )
      for (const uid of memberIds) {
        await tx.conversationMember.create({
          data: {
            conversationId: conversation.id,
            userId: uid,
            role: uid === userId ? 'OWNER' : 'MEMBER',
          },
        })
      }

      // assignee 显示名（§9.3 卡片 assignee 字段）
      let assigneeName: string | null = null
      if (body.assigneeId) {
        const a = await tx.user.findUnique({
          where: { id: body.assigneeId },
          select: { name: true },
        })
        assigneeName = a?.name ?? null
      }

      // ── 动作④：建 ISSUE 详情消息（§9.3 卡片 JSON，issueId=conversation.id）──
      const issueContent = {
        issueId: conversation.id,
        title: body.title,
        urgency,
        status: 'OPEN',
        desc: body.desc ?? '',
        images: body.images ?? [],
        assignee: assigneeName,
        taskId: task.id,
        projectId: body.projectId,
      }
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          type: 'ISSUE',
          content: JSON.stringify(issueContent),
        },
      })

      // ── 动作⑤：建通知 ISSUE_NEW（assigneeId 优先，否则项目 OWNER）──
      const notifyUserId = body.assigneeId ?? projectOwner?.userId ?? null
      if (notifyUserId) {
        await tx.notification.create({
          data: {
            userId: notifyUserId,
            type: 'ISSUE_NEW',
            title: `新问题上报：${body.title}`,
            body: `项目「${project.name}」收到问题上报（${urgency}）${body.desc ? `：${body.desc}` : ''}`,
            link: `/messages?conversation=${conversation.id}`,
          },
        })
      }

      // ── 动作⑥：PG NOTIFY im_events（§9.4；事务提交时投递，回滚不发出）──
      // ① conv:created：被拉入新会话（im-server 按成员房间分发）
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'conv:created',
        conversation: {
          id: conversation.id,
          type: 'ISSUE',
          name: conversation.name,
          projectId: body.projectId,
          createdBy: userId,
          members: memberIds.map((uid) => ({ userId: uid })),
        },
      })})`
      // ② message:new：广播详情消息（im-server 拉最新一条广播到会话房间）
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'message:new',
        conversationId: conversation.id,
      })})`
      // ③ notify:push：实时通知处理人
      if (notifyUserId) {
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'notify:push',
          userId: notifyUserId,
          title: `新问题上报：${body.title}`,
          body: `项目「${project.name}」收到问题上报（${urgency}）`,
          link: `/messages?conversation=${conversation.id}`,
        })})`
      }

      return {
        issueId: conversation.id,
        conversationId: conversation.id,
        taskId: task.id,
      }
    },
    { timeout: 30_000 }
  )

  return created(
    {
      issueId: result.issueId,
      conversationId: result.conversationId,
      taskId: result.taskId,
    },
    '问题上报成功'
  )
})
