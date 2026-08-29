/**
 * /api/reports —— 工作汇报（依据《开发文档-项目管理系统重构》§7.8 / §9.3）
 *
 * POST /api/reports  提交工作汇报 {type:daily|weekly, projectId, done, plan, needHelp, date}
 *                     → 生成 REPORT 消息到项目群 + PG NOTIFY message:new
 * GET  /api/reports?projectId=  按项目归档查询（不传则查「我参与的项目」的 REPORT）
 *
 * 关键设计决策（schema 无独立 Report 表，见任务说明）：
 *   - Report 用 Message 承载，reportId = REPORT 消息的 id（Message.id）
 *   - 消息 content = JSON.stringify({ reportId, kind, date, done, plan, needHelp })（§9.3 卡片结构）
 *   - REPORT 消息落到项目群：Conversation { type:'PROJECT_GROUP', projectId }
 *     （建项目时 phase-engine 已建；找不到则临时按项目成员建群）
 *   - 归档可查：按「会话的 projectId + Message.type='REPORT'」过滤
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  created,
  okPage,
  parsePagination,
  requireAuth,
  ApiError,
} from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

// ───────────────────────────── 请求校验 ─────────────────────────────

const reportSchema = z.object({
  type: z.enum(['daily', 'weekly'], { message: 'type 只能是 daily 或 weekly' }),
  projectId: z.string().trim().min(1, 'projectId 必填'),
  done: z.string().trim().max(5000).optional(),
  plan: z.string().trim().max(5000).optional(),
  needHelp: z.string().trim().max(2000).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
    .optional(),
})

/** 今日 YYYY-MM-DD（本地时区） */
function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 组装 §9.3 REPORT 卡片 JSON 串 */
function reportContent(args: {
  reportId: string
  kind: 'daily' | 'weekly'
  date: string
  done: string
  plan: string
  needHelp: string
}): string {
  return JSON.stringify({
    reportId: args.reportId,
    kind: args.kind,
    date: args.date,
    done: args.done,
    plan: args.plan,
    needHelp: args.needHelp,
  })
}

// ───────────────────────────── POST：提交工作汇报 ─────────────────────────────

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = reportSchema.parse(raw)

  // 权限（§6.1）：需对项目有 view
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: body.projectId })

  const date = body.date ?? todayStr()
  const done = body.done ?? ''
  const plan = body.plan ?? ''
  const needHelp = body.needHelp ?? ''

  const result = await prisma.$transaction(
    async (tx) => {
      // ① 找项目群；找不到则临时按项目成员建一个 PROJECT_GROUP 会话
      let conversation = await tx.conversation.findFirst({
        where: { type: 'PROJECT_GROUP', projectId: body.projectId },
      })
      if (!conversation) {
        const project = await tx.project.findUnique({
          where: { id: body.projectId },
          select: { code: true, name: true },
        })
        if (!project) throw ApiError.notFound('项目不存在')
        conversation = await tx.conversation.create({
          data: {
            type: 'PROJECT_GROUP',
            name: `${project.code} ${project.name}项目群`,
            projectId: body.projectId,
            createdBy: user.userId,
          },
        })
        const members = await tx.projectMember.findMany({
          where: { projectId: body.projectId },
          select: { userId: true },
        })
        for (const m of members) {
          await tx.conversationMember.create({
            data: {
              conversationId: conversation.id,
              userId: m.userId,
              role: m.userId === user.userId ? 'OWNER' : 'MEMBER',
            },
          })
        }
        // 拉群通知（与 phase-engine 动作④ 对齐）
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'conv:created',
          conversation: {
            id: conversation.id,
            type: 'PROJECT_GROUP',
            name: conversation.name,
            projectId: body.projectId,
            createdBy: user.userId,
            members: members.map((m) => ({ userId: m.userId })),
          },
        })})`
      }

      // ② 建 REPORT 消息：reportId = Message.id，先占位创建再回填（保证二者恒等）
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: user.userId,
          type: 'REPORT',
          content: reportContent({
            reportId: '',
            kind: body.type,
            date,
            done,
            plan,
            needHelp,
          }),
        },
      })
      const reportId = message.id
      await tx.message.update({
        where: { id: message.id },
        data: {
          content: reportContent({
            reportId,
            kind: body.type,
            date,
            done,
            plan,
            needHelp,
          }),
        },
      })

      // ③ touch 会话 lastMessageAt
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      })

      // ④ PG NOTIFY message:new（§9.4，事务提交时投递）
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'message:new',
        conversationId: conversation.id,
      })})`

      return { reportId, conversationId: conversation.id }
    },
    { timeout: 30_000 },
  )

  return created(
    { reportId: result.reportId, conversationId: result.conversationId },
    '工作汇报已提交',
  )
})

// ───────────────────────────── GET：按项目归档查询 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('projectId')?.trim() || undefined
  const { page, limit, skip } = parsePagination(request, 20)

  // 权限过滤（§6.1）
  let where: Prisma.MessageWhereInput
  if (projectId) {
    await requireCan(user.userId, 'view', { type: 'PROJECT', id: projectId })
    where = { type: 'REPORT', conversation: { projectId } }
  } else {
    // 我参与的项目（ADMIN 全量）；REPORT 只会落在项目群，故限定 projectId 非空
    where = {
      type: 'REPORT',
      conversation: {
        projectId: { not: null },
        ...(user.role === 'ADMIN'
          ? {}
          : { project: { members: { some: { userId: user.userId } } } }),
      },
    }
  }

  // 分页下推 DB：skip/take + count 于 DB 层完成（P4 P2-5）
  const [total, messages] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: limit,
      include: {
        sender: { select: { id: true, name: true, email: true, avatar: true } },
        conversation: {
          select: {
            projectId: true,
            project: { select: { id: true, name: true, code: true } },
          },
        },
      },
    }),
  ])

  // content JSON 解析 + 关联 sender/会话 project，按 date 倒序（date 在 JSON 内，JS 层排序）
  const parsed = messages.map((m) => {
    let obj: Record<string, unknown> = {}
    try {
      obj = JSON.parse(m.content)
    } catch {
      /* 非法 JSON 按空对象兜底 */
    }
    return {
      reportId: typeof obj.reportId === 'string' ? obj.reportId : m.id,
      kind: typeof obj.kind === 'string' ? obj.kind : null,
      date: typeof obj.date === 'string' ? obj.date : null,
      done: typeof obj.done === 'string' ? obj.done : '',
      plan: typeof obj.plan === 'string' ? obj.plan : '',
      needHelp: typeof obj.needHelp === 'string' ? obj.needHelp : '',
      sender: m.sender
        ? { id: m.sender.id, name: m.sender.name, email: m.sender.email, avatar: m.sender.avatar }
        : null,
      createdAt: m.createdAt,
      projectId: m.conversation.projectId ?? null,
      projectName: m.conversation.project?.name ?? null,
      projectCode: m.conversation.project?.code ?? null,
    }
  })

  // 按 date 倒序（YYYY-MM-DD 字典序即时间序），同日期按 createdAt 倒序（仅对当页排序）
  parsed.sort((a, b) => {
    const da = a.date ?? ''
    const db = b.date ?? ''
    if (da !== db) return da < db ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })

  return okPage(parsed, page, limit, total)
})
