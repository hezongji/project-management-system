/**
 * /api/tasks/[id] —— 依据《开发文档-项目管理系统重构》§7.6 / §4.7 / §8.2③
 *
 * GET   /api/tasks/:id   任务 view   任务详情（抽屉数据源）：
 *                        基本信息 + 修订/标注/评论计数与列表 + permissions
 *                        （按钮级权限由 data.permissions 驱动，§4.7）
 * PATCH /api/tasks/:id   任务 edit（assignee/创建人/上级负责人，§6.1 三层合成）
 *                        普通更新：白名单字段，不生成修订（重大变更走 revisions API）
 *
 * 联动：PATCH 后调 phase-engine.onTaskChanged（status/assignee 变更触发阶段
 * 状态机四规则，§7.5）；assignee 变更生成 TASK_ASSIGNED 通知（§5 NotifType）。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  ok,
  ApiError,
  requireAuth,
} from '@/lib/api-helpers'
import { requireCan, permsOf, invalidatePerms } from '@/lib/permission'
import { visibleTaskFilter } from '@/lib/data-visibility'
import { onTaskChanged, EngineError } from '@/lib/phase-engine'
import { ensureTaskTodo } from '@/lib/todo-service'
import { notifyTaskStatusChanged, notifyTaskAssigned } from '@/lib/notify/webhook'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/** 抽屉/详情统一返回形态 */
async function buildDetail(taskId: string, userId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      phase: { select: { id: true, code: true, name: true, status: true } },
      project: { select: { id: true, code: true, name: true, isArchived: true } },
      assignee: { select: { id: true, name: true, email: true, avatar: true } },
      creator: { select: { id: true, name: true, email: true, avatar: true } },
      revisions: {
        orderBy: { version: 'desc' },
        include: { changedBy: { select: { id: true, name: true, avatar: true } } },
      },
      annotations: {
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, avatar: true } } },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, avatar: true } } },
      },
    },
  })
  if (!task) throw ApiError.notFound('任务不存在')

  const permissions = await permsOf(userId, { type: 'TASK', id: task.id })

  // @联想候选：项目成员（§8.2③ 评论 @联想数据源，限 100 人）
  const mentionCandidates = await prisma.projectMember.findMany({
    where: { projectId: task.projectId },
    select: {
      user: { select: { id: true, name: true, email: true, avatar: true } },
      title: true,
    },
    take: 100,
  })

  return {
    ...task,
    permissions,
    mentionCandidates: mentionCandidates.map((m) => ({
      ...m.user,
      title: m.title,
    })),
  }
}

// ───────────────────────────── GET：任务详情 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'view', { type: 'TASK', id })
  return ok(await buildDetail(id, user.userId))
})

// ───────────────────────────── PATCH：普通更新 ─────────────────────────────

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
  })
  .strict()

export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  await requireCan(user.userId, 'edit', { type: 'TASK', id })

  const body = patchSchema.parse(await request.json())
  if (Object.keys(body).length === 0) {
    throw ApiError.badRequest('请求体不能为空（可更新：title/description/status/priority/assigneeId/dueDate）')
  }

  // P2-2 通知上下文：记录变更前后关键信息（供事务后 fire-and-forget 使用）
  let oldStatus = ''
  let oldAssigneeId: string | null = null
  let projectName: string | undefined
  let assigneeName: string | undefined

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        assigneeId: true,
        startedAt: true,
        completedAt: true,
      },
    })
    if (!task) throw new EngineError(404, '任务不存在', 'NOT_FOUND')
    oldStatus = task.status
    oldAssigneeId = task.assigneeId

    const project = await tx.project.findUnique({
      where: { id: task.projectId },
      select: { isArchived: true, name: true },
    })
    projectName = project?.name
    if (project?.isArchived) {
      throw new EngineError(403, '项目已归档，任务只读', 'FORBIDDEN')
    }

    if (body.assigneeId) {
      const target = await tx.user.findUnique({
        where: { id: body.assigneeId },
        select: { id: true, name: true },
      })
      if (!target) throw new EngineError(400, `assigneeId 不存在：${body.assigneeId}`)
      assigneeName = target.name
    }

    const data: Prisma.TaskUpdateInput = {}
    if (body.title !== undefined) data.title = body.title
    if (body.description !== undefined) data.description = body.description
    if (body.status !== undefined) data.status = body.status
    if (body.priority !== undefined) data.priority = body.priority
    if (body.assigneeId !== undefined) {
      data.assignee = body.assigneeId
        ? { connect: { id: body.assigneeId } }
        : { disconnect: true }
    }
    if (body.dueDate !== undefined) {
      data.dueDate = body.dueDate ? new Date(body.dueDate) : null
    }

    // 状态语义自动化（§5 startedAt/completedAt 字段语义）
    if (body.status === 'IN_PROGRESS' && !task.startedAt) {
      data.startedAt = new Date()
    }
    if (body.status === 'DONE') {
      data.completedAt = new Date()
      if (!task.startedAt && !('startedAt' in data)) data.startedAt = new Date()
    }
    if (
      task.status === 'DONE' &&
      body.status !== undefined &&
      body.status !== 'DONE'
    ) {
      data.completedAt = null // 离开 DONE 撤销完成时间
    }

    const updated = await tx.task.update({ where: { id: task.id }, data })

    // assignee 变更 → TASK_ASSIGNED 通知 + 新 assignee 待办（§5 NotifType / §7.9）
    if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId && body.assigneeId) {
      await tx.notification.create({
        data: {
          userId: body.assigneeId,
          type: 'TASK_ASSIGNED',
          title: `任务已指派给你：${updated.title}`,
          body: `项目内任务「${updated.title}」指派给你，请及时处理`,
          link: `/projects/${task.projectId}/tasks/${task.id}`,
        },
      })
      await ensureTaskTodo(tx, {
        assigneeId: body.assigneeId,
        taskId: task.id,
        title: updated.title,
        projectId: task.projectId,
        dueDate: updated.dueDate,
        priority: updated.priority,
      })
    }

    return updated
  })

  // P2-2 通知集成：状态变更 / 指派 → 企业微信/钉钉 webhook（fire-and-forget，失败绝不影响主流程）
  if (body.status !== undefined && body.status !== oldStatus) {
    void notifyTaskStatusChanged({
      projectId: result.projectId,
      projectName,
      taskId: result.id,
      taskTitle: result.title,
      fromStatus: oldStatus,
      toStatus: body.status,
    }).catch(() => {})
  }
  if (body.assigneeId !== undefined && body.assigneeId !== oldAssigneeId && body.assigneeId) {
    void notifyTaskAssigned({
      projectId: result.projectId,
      projectName,
      taskId: result.id,
      taskTitle: result.title,
      assigneeName,
    }).catch(() => {})
  }

  // 任务状态/字段变更 → 阶段状态机联动（§7.5）
  const linkage = await onTaskChanged(id).catch(() => null)

  return ok(
    { ...(await buildDetail(id, user.userId)), _linkage: linkage },
    '任务更新成功',
  )
})

// ───────────────────────────── DELETE：删除任务（P2-9） ─────────────────────────────

/**
 * DELETE /api/tasks/:id  任务 edit 权限
 *
 * 实现策略（复用引擎保证联动正确）：
 *  1. 非 CANCELLED 的任务先置为 CANCELLED → onTaskChanged 重算阶段
 *     （CANCELLED 已被引擎剔除出分母，§7.5 规则 4），随后物理删除；
 *  2. 子表级联（schema 实况）：标注/评论 onDelete: Cascade 随任务删除；任务修订为审计
 *     快照 onDelete: SetNull（taskId 置空保留历史，非遗 Cascade）；TodoItem.sourceId 无
 *     外键 → 删除事务内显式清理 sourceType=TASK 待办（QA-B4c bug③，防孤儿待办）；
 *  3. 归档项目内任务只读，禁止删除；删后 invalidatePerms 清权限缓存。
 */
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  // 双闸①：可见性 —— 任务不在可见范围 → 404（不暴露存在，删除工程铁律 §2.1，第 3 棒补齐）
  const visFilter = await visibleTaskFilter(user.userId, user.role)
  const task = await prisma.task.findFirst({
    where: { id, ...visFilter },
    select: { id: true, projectId: true, status: true, project: { select: { isArchived: true } } },
  })
  if (!task) throw ApiError.notFound('任务不存在')

  // 双闸②：权限（既有 edit 口径不变：OWNER/MANAGER/阶段负责人/负责人/ADMIN；
  // 归档项目非 ADMIN 已被引擎终审拦截）
  await requireCan(user.userId, 'edit', { type: 'TASK', id })
  if (task.project.isArchived) throw ApiError.forbidden('项目已归档，任务只读，禁止删除')

  // 先置 CANCELLED 触发阶段状态机重算（避免删除后分母突变），再物理删除
  if (task.status !== 'CANCELLED') {
    await prisma.task.update({ where: { id }, data: { status: 'CANCELLED' } })
    await onTaskChanged(id).catch(() => null)
  }
  // QA-B4c bug③：TASK 源待办 sourceId 无 FK，与任务删除同事务显式清理，防孤儿待办（点开 404）
  await prisma.$transaction([
    prisma.todoItem.deleteMany({ where: { sourceType: 'TASK', sourceId: id } }),
    prisma.task.delete({ where: { id } }),
  ])
  invalidatePerms()

  return ok({ deleted: true, id }, '任务已删除')
})
