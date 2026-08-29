/**
 * /api/projects/[id] —— 依据《开发文档-项目管理系统重构》§7.4
 *
 * GET    项目 view   详情（含 phase 概览 / 我的角色 / 项目级 can）
 * PATCH  项目 edit   基本信息维护 { name?, description?, contractNo?, location?,
 *                     amount?, customerId?, signedAt?, plannedStart?, plannedEnd?, priority? }
 * DELETE 项目 delete 物理删除（仅 ADMIN / 项目 OWNER；删除工程第 2 棒，§2）
 *                     —— 归档项目冻结不可删；存在采购订单（财务审计链）时引用保护拒绝；
 *                     事务级联：成员/阶段(任务·修订·批注·评论)/目录/条目(文件)/待办/通知/
 *     催办/采购清单/会话成员（会话本体保留，Conversation.projectId 由 FK SET NULL 解除）；
 *                     logDelete 审计（projectId 置空：项目行已删，ActivityLog.projectId FK 不存在）
 *
 * 说明：
 *  - 归档项目只读由权限引擎终审拦截（isArchived → edit=false → requireCan 403）
 *  - progress 为动态计算（Phase 均值，Project 无持久字段，§5）
 *  - PATCH 记 ActivityLog（detail 记录各字段 [旧值, 新值]）并失效权限缓存
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, invalidateProject } from '@/lib/permission'
import { assertDeletable, logDelete } from '@/lib/delete-helpers'
import { computeProjectProgress } from '@/lib/phase-engine'
import { canViewFinance, maskFinance, visibleProjectFilter } from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// ───────────────────────────── GET：详情 ─────────────────────────────

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const project = await prisma.project.findUnique({
    where: { id: id },
    include: {
      customer: { select: { id: true, name: true, type: true } },
      template: { select: { id: true, name: true } },
      phases: {
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          status: true,
          progress: true,
          plannedStart: true,
          plannedEnd: true,
          owner: { select: { id: true, name: true, avatar: true } },
        },
        orderBy: { order: 'asc' },
      },
    },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const [myRoleRow, perms, progress] = await Promise.all([
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: user.userId } },
      select: { role: true },
    }),
    permsOf(user.userId, { type: 'PROJECT', id: id }),
    computeProjectProgress(id),
  ])

  const { phases, customer, template, ...rest } = project
  const myRole = user.role === 'ADMIN' ? 'ADMIN' : myRoleRow?.role ?? null
  // 财务脱敏（权限 V2）：非 ADMIN/财务部/项目OWNER/MANAGER 看不到金额与合同号
  const deptRow = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { department: { select: { name: true } } },
  })
  const finOk = canViewFinance(user.role, deptRow?.department?.name ?? null, myRole)
  const maskedRest = maskFinance(rest, finOk)
  return ok({
    project: {
      ...maskedRest,
      amount: maskedRest.amount === null ? null : Number(maskedRest.amount),
      progress,
      myRole,
      can: { edit: perms.edit, archive: perms.archive },
      customer,
      template,
    },
    // phase 概览（§7.4 详情契约；完整根树走 /tree）
    phaseOverview: phases.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      order: p.order,
      status: p.status,
      progress: p.progress,
      plannedStart: p.plannedStart,
      plannedEnd: p.plannedEnd,
      owner: p.owner,
    })),
  })
})

// ───────────────────────────── PATCH：基本信息维护 ─────────────────────────────

const dateStr = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日期格式非法' })

const patchSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  contractNo: z.string().trim().max(100).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  amount: z
    .union([z.number().nonnegative('合同金额不能为负'), z.string()])
    .nullable()
    .optional(),
  customerId: z.string().trim().nullable().optional(),
  signedAt: dateStr.nullable().optional(),
  plannedStart: dateStr.nullable().optional(),
  plannedEnd: dateStr.nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
})

type PatchBody = z.infer<typeof patchSchema>

/** 数值/字符串统一转 Prisma 入参（amount 兼容字符串数字） */
function toAmount(v: NonNullable<PatchBody['amount']>): number | string {
  return typeof v === 'number' ? v : Number(v)
}

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchSchema.parse(raw)
  if (Object.keys(body).length === 0) {
    throw ApiError.badRequest('没有可更新的字段')
  }

  const project = await prisma.project.findUnique({ where: { id: id } })
  if (!project) throw ApiError.notFound('项目不存在')

  // 权限 V2 修复（P1-2）：PATCH 财务字段判定必须传真实 memberRole（与 GET 侧口径一致），
  // 否则项目 OWNER/MANAGER 会被误判无财务权限，永远改不了金额/合同号
  const deptRow = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { department: { select: { name: true } } },
  })
  const memberRow = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: id, userId: user.userId } },
    select: { role: true },
  })
  const memberRoleForFin = user.role === 'ADMIN' ? 'ADMIN' : (memberRow?.role ?? null)
  const finOk = canViewFinance(user.role, deptRow?.department?.name ?? null, memberRoleForFin)
  if (!finOk) {
    delete (body as Record<string, unknown>).amount
    delete (body as Record<string, unknown>).contractNo
  }

  if (body.customerId) {
    const org = await prisma.externalOrg.findUnique({
      where: { id: body.customerId },
      select: { id: true },
    })
    if (!org) throw ApiError.badRequest('客户主体不存在')
  }
  if (body.plannedStart && body.plannedEnd) {
    if (new Date(body.plannedStart) > new Date(body.plannedEnd)) {
      throw ApiError.badRequest('计划开始日期不能晚于计划结束日期')
    }
  }

  const data: Record<string, unknown> = {}
  const detail: Record<string, [unknown, unknown]> = {}
  const DATE_FIELDS = new Set(['signedAt', 'plannedStart', 'plannedEnd'])
  const fieldMap: (keyof PatchBody)[] = [
    'name',
    'description',
    'contractNo',
    'location',
    'customerId',
    'signedAt',
    'plannedStart',
    'plannedEnd',
    'priority',
  ]
  for (const f of fieldMap) {
    if (body[f] !== undefined) {
      const v = body[f] as string | null
      data[f] = DATE_FIELDS.has(f) ? (v === null ? null : new Date(v)) : v
      detail[f] = [project[f as keyof typeof project] ?? null, v]
    }
  }
  if (body.amount !== undefined) {
    const v = body.amount === null ? null : toAmount(body.amount)
    data.amount = v
    detail.amount = [
      project.amount === null ? null : Number(project.amount),
      body.amount === null ? null : Number(toAmount(body.amount)),
    ]
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.project.update({ where: { id: id }, data })
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'project.update',
        detail: detail as unknown as Prisma.InputJsonValue,
      },
    })
    return row
  })

  invalidateProject(id)

  return ok({
    project: {
      ...updated,
      amount: updated.amount === null ? null : Number(updated.amount),
    },
    message: '项目信息已更新',
  })
})

// ───────────────────── DELETE：删除项目（删除工程第 2 棒，§2/§2.4/§2.5）─────────────────────

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  // 权限：ADMIN（以 DB 实时角色为准，防 JWT 降级窗口，同 requireAdmin 口径）或项目 OWNER
  // 可见性闸（M2 修复）：先过 visibleProjectFilter，不可见与不存在统一 404，防存在性探测
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { role: true, isActive: true },
  })
  const project = await prisma.project.findFirst({
    where: {
      id: id,
      ...(await visibleProjectFilter(user.userId, dbUser?.role ?? 'MEMBER')),
    },
    select: { id: true, code: true, name: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: id, userId: user.userId } },
    select: { role: true },
  })
  const isAdmin = !!dbUser && dbUser.isActive && dbUser.role === 'ADMIN'
  const isOwner = member?.role === 'OWNER'
  if (!isAdmin && !isOwner) {
    throw ApiError.forbidden('仅系统管理员或项目负责人（OWNER）可删除项目')
  }

  // 状态限制：归档项目冻结（只读态），需先解除归档
  if (project.isArchived) {
    throw ApiError.badRequest('已归档项目不可删除，请先解除归档后再执行删除')
  }

  // 引用保护（§2.3）：采购订单（合同/付款/到货链）属财务审计链 → 拒绝物理删除，改用归档
  const purchaseOrderCount = await prisma.purchaseOrder.count({
    where: { projectId: id },
  })
  assertDeletable(purchaseOrderCount, `项目「${project.code}」（存在采购订单）`)

  // 事务：明细级联（FK 不覆盖部分）→ 结构级联 → 物理删除项目行
  const deleted = await prisma.$transaction(async (tx) => {
    // 1) 收集关联实体 id 集（定位待办/通知/催办等无 FK 关联的记录）
    const [phases, tasks, requirements, conversations, purchaseReqs] = await Promise.all([
      tx.phase.findMany({ where: { projectId: id }, select: { id: true } }),
      tx.task.findMany({ where: { projectId: id }, select: { id: true } }),
      tx.fileRequirement.findMany({ where: { projectId: id }, select: { id: true } }),
      tx.conversation.findMany({ where: { projectId: id }, select: { id: true } }),
      tx.purchaseRequest.findMany({ where: { projectId: id }, select: { id: true } }),
    ])
    const phaseIds = phases.map((p) => p.id)
    const taskIds = tasks.map((t) => t.id)
    const requirementIds = requirements.map((r) => r.id)
    const conversationIds = conversations.map((c) => c.id)
    const purchaseRequestIds = purchaseReqs.map((p) => p.id)

    // 2) 任务附属（批注/修订/评论）计数（随 Task Cascade，仅统计不显式删）
    const [annotationCount, revisionCount, commentCount] = taskIds.length
      ? await Promise.all([
          tx.annotation.count({ where: { taskId: { in: taskIds } } }),
          tx.taskRevision.count({ where: { taskId: { in: taskIds } } }),
          tx.comment.count({ where: { taskId: { in: taskIds } } }),
        ])
      : [0, 0, 0]

    // 3) 明细级联（显式删除以精确统计）
    //    文件必须先删：File.requirementId 为 SET NULL，随条目删除会留孤儿记录
    const files = await tx.file.deleteMany({ where: { projectId: id } })
    const urgeRecords = requirementIds.length
      ? await tx.urgeRecord.deleteMany({ where: { requirementId: { in: requirementIds } } })
      : { count: 0 }
    const todoBranches = [
      ...(taskIds.length
        ? [{ sourceType: 'TASK' as const, sourceId: { in: taskIds } }] : [])
      ,
      ...(phaseIds.length
        ? [{ sourceType: 'PHASE' as const, sourceId: { in: phaseIds } }] : [])
      ,
      ...(requirementIds.length
        ? [{ sourceType: 'FILE_REQ' as const, sourceId: { in: requirementIds } }] : [])
      ,
      ...(purchaseRequestIds.length
        ? [{ sourceType: 'PURCHASE_REQUEST' as const, sourceId: { in: purchaseRequestIds } }] : [])
      ,
    ]
    const todoItems = todoBranches.length
      ? await tx.todoItem.deleteMany({ where: { OR: todoBranches } })
      : { count: 0 }
    // 通知无 FK，按 link 前缀/精确匹配清理（cuid 定长，前缀不会误伤其他项目）
    const notifications = await tx.notification.deleteMany({
      where: {
        OR: [
          { link: { startsWith: `/projects/${id}/` } },
          { link: { startsWith: `/files?projectId=${id}` } },
          ...purchaseRequestIds.map((id) => ({ link: `/purchase?requestId=${id}` })),
        ],
      },
    })
    // 会话成员解除（会话本体与消息保留供审计，Conversation.projectId 由 FK SET NULL 解除）
    const conversationMembers = conversationIds.length
      ? await tx.conversationMember.deleteMany({
          where: { conversationId: { in: conversationIds } },
        })
      : { count: 0 }

    // 4) 结构级联（大部分有 FK Cascade 兕底，显式删保统计准确）
    const fileRequirements = await tx.fileRequirement.deleteMany({
      where: { projectId: id },
    })
    const fileCatalogs = await tx.fileCatalog.deleteMany({
      where: { projectId: id },
    })
    const supplierRequests = await tx.supplierRequest.deleteMany({
      where: { projectId: id },
    })
    const goodsArrivals = await tx.goodsArrival.deleteMany({
      where: { projectId: id },
    })
    const purchaseRequests = await tx.purchaseRequest.deleteMany({
      where: { projectId: id },
    })
    const members = await tx.projectMember.deleteMany({
      where: { projectId: id },
    })
    const tasksDeleted = await tx.task.deleteMany({ where: { projectId: id } })
    const phasesDeleted = await tx.phase.deleteMany({ where: { projectId: id } })
    // 活动日志保留（审计链）：ActivityLog.projectId 由 FK SET NULL，历史记录不丢
    await tx.project.delete({ where: { id: id } })

    return {
      phases: phasesDeleted.count,
      tasks: tasksDeleted.count,
      annotations: annotationCount,
      taskRevisions: revisionCount,
      comments: commentCount,
      fileCatalogs: fileCatalogs.count,
      fileRequirements: fileRequirements.count,
      files: files.count,
      todoItems: todoItems.count,
      notifications: notifications.count,
      urgeRecords: urgeRecords.count,
      conversationMembers: conversationMembers.count,
      purchaseRequests: purchaseRequests.count,
      supplierRequests: supplierRequests.count,
      goodsArrivals: goodsArrivals.count,
      members: members.count,
    }
  })

  invalidateProject(id)

  // 审计留痕（§2.5）：项目行已删，projectId 必须留空（ActivityLog.projectId FK）
  await logDelete(user.userId, 'project', id, {
    code: project.code,
    name: project.name,
    ...deleted,
  })

  return ok(
    { id: id, code: project.code, name: project.name, deleted },
    '项目已删除',
  )
})
