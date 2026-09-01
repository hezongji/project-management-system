/**
 * /api/phases/[id]/tasks —— 依据《开发文档-项目管理系统重构》§7.6 / §8.2②
 *
 * POST  阶段 assign   在阶段下建任务（阶段下钻页看板「+」入口）：
 *        body { title, description?, status?, priority?, assigneeId?, dueDate? }
 *        - 任务强制挂在该阶段（phaseId 由路径决定，projectId 取自阶段）
 *        - 项目归档 → 403；assigneeId 需真实存在
 *        - 建后调 onTaskChanged（§7.5：新任务改变阶段任务分母/完成率）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { ensureTaskTodo, taskAssignedPayload } from '@/lib/todo-service'
import { requireCan } from '@/lib/permission'
import { onTaskChanged, EngineError } from '@/lib/phase-engine'
import { notifyTaskCreated, notifyTaskAssigned } from '@/lib/notify/webhook'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const createSchema = z
  .object({
    title: z.string().min(1, '任务标题不能为空').max(200),
    description: z.string().max(5000).optional(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    assigneeId: z.string().optional().nullable(),
    dueDate: z.string().optional().nullable(),
  })
  .strict()

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  // 阶段 assign 权限（§6.1：阶段负责人 task.*、MANAGER/OWNER/ADMIN）
  await requireCan(user.userId, 'assign', { type: 'PHASE', id })

  const body = createSchema.parse(await request.json())

  const task = await prisma.$transaction(async (tx) => {
    const phase = await tx.phase.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        name: true,
        projectId: true,
        status: true,
        project: { select: { isArchived: true, code: true } },
      },
    })
    if (!phase) throw new EngineError(404, '阶段不存在', 'NOT_FOUND')
    if (phase.project.isArchived) {
      throw new EngineError(403, '项目已归档，无法创建任务', 'FORBIDDEN')
    }
    if (phase.status === 'SKIPPED') {
      throw new EngineError(400, `阶段 ${phase.code} 已跳过，不能在其下建任务`)
    }

    if (body.assigneeId) {
      const target = await tx.user.findUnique({
        where: { id: body.assigneeId },
        select: { id: true },
      })
      if (!target) throw new EngineError(400, `assigneeId 不存在：${body.assigneeId}`)
    }

    const status = body.status ?? 'TODO'
    const now = new Date()
    const createdTask = await tx.task.create({
      data: {
        title: body.title.trim(),
        description: body.description ?? null,
        projectId: phase.projectId,
        phaseId: phase.id,
        status,
        priority: body.priority ?? 'MEDIUM',
        assigneeId: body.assigneeId ?? null,
        creatorId: user.userId,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        ...(status === 'IN_PROGRESS' && { startedAt: now }),
        ...(status === 'DONE' && { startedAt: now, completedAt: now }),
      },
      include: {
        phase: { select: { id: true, code: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        assignee: { select: { id: true, name: true, email: true } },
        creator: { select: { id: true, name: true, email: true } },
        _count: { select: { annotations: true, revisions: true, comments: true } },
      },
    })

    // §7.9：阶段下建任务即指派 → 给新 assignee 写待办 + 通知（全源聚合）
    if (body.assigneeId) {
      await ensureTaskTodo(tx, {
        assigneeId: body.assigneeId,
        taskId: createdTask.id,
        title: createdTask.title,
        projectId: phase.projectId,
        dueDate: createdTask.dueDate,
        priority: createdTask.priority,
      })
      await tx.notification.create({
        data: {
          userId: body.assigneeId,
          ...taskAssignedPayload(createdTask.title, phase.projectId, createdTask.id),
        },
      })
    }

    return createdTask
  })

  // 新任务改变阶段任务分母 → 状态机联动（§7.5）
  const linkage = await onTaskChanged(task.id).catch(() => null)

  // P2-2 通知集成：阶段下任务创建 → 企业微信/钉钉 webhook（fire-and-forget，失败绝不影响主流程）
  void notifyTaskCreated({
    projectId: task.projectId,
    projectName: task.project?.name,
    taskId: task.id,
    taskTitle: task.title,
    operatorName: task.creator?.name,
    assigneeName: task.assignee?.name ?? undefined,
  }).catch(() => {})
  if (body.assigneeId) {
    void notifyTaskAssigned({
      projectId: task.projectId,
      projectName: task.project?.name,
      taskId: task.id,
      taskTitle: task.title,
      operatorName: task.creator?.name,
      assigneeName: task.assignee?.name ?? undefined,
    }).catch(() => {})
  }

  return created({ ...task, _linkage: linkage }, '任务创建成功')
})
