/**
 * /api/projects/[id]/deliverables —— 个人交付物看板（2026-08-21）
 *
 * GET  项目成员  按成员分组：每位成员应提交的交付物清单 + 状态 + 完成度
 * POST MANAGER/OWNER/ADMIN  催办（urge）：对未提交条目生成待办 + IM 通知
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { urgeRequirements } from '@/lib/phase-engine'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const PENDING_STATUS = ['WAITING', 'REVIEWING', 'REJECTED'] as const

// ───────────────────────────── GET：看板 ─────────────────────────────

export const GET = apiHandler(async (_request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(_request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { code: true, name: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  // 项目成员（看板按成员分组）
  const members = await prisma.projectMember.findMany({
    where: { projectId: id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })

  // 全部交付物（ownerId 非空 = 个人交付物；含阶段交付物作对比）
  const reqs = await prisma.fileRequirement.findMany({
    where: { projectId: id },
    select: {
      id: true,
      name: true,
      code: true,
      ownerId: true,
      phaseCode: true,
      dueDate: true,
      status: true,
      updatedAt: true,
      _count: { select: { files: true } },
    },
    orderBy: [{ phaseCode: 'asc' }, { createdAt: 'asc' }],
  })

  const now = new Date()
  const membersView = members.map((m) => {
    const mine = reqs.filter((r) => r.ownerId === m.userId)
    const submitted = mine.filter((r) => r.status === 'SUBMITTED' || r.status === 'APPROVED' || r.status === 'REVIEWING')
    const pending = mine.filter((r) => (PENDING_STATUS as readonly string[]).includes(r.status))
    const overdue = pending.filter((r) => r.dueDate && r.dueDate < now)
    return {
      userId: m.userId,
      name: m.user.name,
      username: m.user.username,
      department: m.user.department?.name ?? null,
      role: m.role,
      total: mine.length,
      submitted: submitted.length,
      pending: pending.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        phaseCode: r.phaseCode,
        dueDate: r.dueDate,
        status: r.status,
        fileCount: r._count.files,
        overdue: !!(r.dueDate && r.dueDate < now),
      })),
      overdueCount: overdue.length,
    }
  })

  return ok({
    project: { id: id, code: project.code, name: project.name },
    members: membersView,
    stats: {
      totalReqs: reqs.length,
      submittedReqs: reqs.filter(
        (r) => r.status === 'SUBMITTED' || r.status === 'APPROVED',
      ).length,
    },
  })
})

// ───────────────────────────── POST：催办 ─────────────────────────────

const urgeSchema = z.object({
  requirementIds: z.array(z.string().trim().min(1)).min(1, '请选择要催办的交付物'),
})

export const POST = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = urgeSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { code: true, name: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const result = await urgeRequirements(prisma, id, body.requirementIds, user.userId)

  return ok(
    { notifiedUserIds: result.notifiedUserIds, notified: result.notifiedUserIds.length },
    `已催办 ${result.notifiedUserIds.length} 位成员`,
  )
})
