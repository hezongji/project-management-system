/**
 * /api/projects/[id]/tree —— 依据《开发文档-项目管理系统重构》§7.4（响应契约核心，逐字段对齐）
 *
 * GET  项目 view  ★ 根树聚合（Phase + Task 计数 + 负责人 + 进度 + 文件统计 + 延误标记）
 *
 * 响应 data 契约（§7.4 示例）：
 *   project:  { id, code, name, status, amount, contractNo, location, signedAt,
 *              plannedStart, plannedEnd, progress, myRole, can: { edit, archive } }
 *   phases[]: { id, code, name, order, status, owner: { id, name, avatar } | null,
 *              plannedStart, plannedEnd, actualEnd, progress, taskCount, taskDone,
 *              fileStats: { total, approved }, delayed }
 *   fileSummary: { required, approved, waiting, rejected }   ← 必需(required=true)条目按状态计数
 *   members[]: { userId, name, role, title }
 *
 * 计算口径：
 *   - project.progress = Phase 均值（SKIPPED 不计分母，§7.5）→ computeProjectProgress
 *   - taskCount / taskDone = 阶段下有效任务（CANCELLED 剔除）总数 / DONE 数（与 §7.5 联动规则一致）
 *   - fileStats = 该阶段（phaseCode 关联）文件条目总数 / 其中 APPROVED 数
 *   - fileSummary = required=true 条目的总数与 APPROVED / WAITING / REJECTED 计数
 *   - delayed = plannedEnd < 今天 且 status ≠ DONE（§8.2① 延误红标，服务端统一计算）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf } from '@/lib/permission'
import { computeProjectProgress } from '@/lib/phase-engine'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const project = await prisma.project.findUnique({
    where: { id: id },
    include: {
      customer: { select: { id: true, name: true } },
      members: {
        select: {
          userId: true,
          role: true,
          title: true,
          user: { select: { id: true, name: true, avatar: true } },
        },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      },
    },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const [phases, myRoleRow, perms, progress] = await Promise.all([
    prisma.phase.findMany({
      where: { projectId: id },
      include: {
        owner: { select: { id: true, name: true, avatar: true } },
        tasks: { select: { status: true } },
      },
      orderBy: { order: 'asc' },
    }),
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: user.userId } },
      select: { role: true },
    }),
    permsOf(user.userId, { type: 'PROJECT', id: id }),
    computeProjectProgress(id),
  ])

  // 文件统计：按 phaseCode 分组（total / approved），一条 groupBy 查询完成
  const grouped = await prisma.fileRequirement.groupBy({
    by: ['phaseCode', 'status'],
    where: { projectId: id },
    _count: { _all: true },
  })
  const fileStatsByPhase = new Map<string, { total: number; approved: number }>()
  for (const g of grouped) {
    const code = g.phaseCode ?? ''
    const cur = fileStatsByPhase.get(code) ?? { total: 0, approved: 0 }
    cur.total += g._count._all
    if (g.status === 'APPROVED') cur.approved += g._count._all
    fileStatsByPhase.set(code, cur)
  }

  // fileSummary：必需条目（required=true）按状态计数（§7.4 契约 required = approved+waiting+rejected 口径）
  const requiredGrouped = await prisma.fileRequirement.groupBy({
    by: ['status'],
    where: { projectId: id, required: true },
    _count: { _all: true },
  })
  const fileSummary = { required: 0, approved: 0, waiting: 0, rejected: 0 }
  for (const g of requiredGrouped) {
    fileSummary.required += g._count._all
    if (g.status === 'APPROVED') fileSummary.approved += g._count._all
    if (g.status === 'WAITING') fileSummary.waiting += g._count._all
    if (g.status === 'REJECTED') fileSummary.rejected += g._count._all
  }

  // 延误判定：plannedEnd < 今天（按日截断）且 status ≠ DONE（§8.2①）
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const phaseNodes = phases.map((p) => {
    const effective = p.tasks.filter((t) => t.status !== 'CANCELLED')
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      order: p.order,
      status: p.status,
      owner: p.owner,
      plannedStart: p.plannedStart,
      plannedEnd: p.plannedEnd,
      actualEnd: p.actualEnd,
      progress: p.progress,
      taskCount: effective.length,
      taskDone: effective.filter((t) => t.status === 'DONE').length,
      fileStats: fileStatsByPhase.get(p.code) ?? { total: 0, approved: 0 },
      delayed:
        p.plannedEnd !== null &&
        new Date(p.plannedEnd) < today &&
        p.status !== 'DONE',
    }
  })

  return ok({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      status: project.status,
      amount: project.amount === null ? null : Number(project.amount),
      contractNo: project.contractNo,
      location: project.location,
      signedAt: project.signedAt,
      plannedStart: project.plannedStart,
      plannedEnd: project.plannedEnd,
      progress,
      myRole: user.role === 'ADMIN' ? 'ADMIN' : myRoleRow?.role ?? null,
      customer: project.customer,
      isArchived: project.isArchived,
      can: { edit: perms.edit, archive: perms.archive },
    },
    phases: phaseNodes,
    fileSummary,
    isLegacy: phases.length === 0,
    members: project.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      role: m.role,
      title: m.title,
    })),
  })
})
