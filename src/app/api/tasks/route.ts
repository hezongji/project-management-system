import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, okPage, created, parsePagination, requireAuth, ApiError } from '@/lib/api-helpers'
import { ensureTaskTodo, taskAssignedPayload } from '@/lib/todo-service'
import { visibleTaskFilter } from '@/lib/data-visibility'
import { requireCan } from '@/lib/permission'
import { notifyTaskCreated, notifyTaskAssigned } from '@/lib/notify/webhook'
import { z } from 'zod'

const createTaskSchema = z.object({
  title: z.string().min(1, '任务标题不能为空'),
  description: z.string().optional(),
  projectId: z.string().min(1, '项目ID不能为空'),
  phaseId: z.string().optional(), // ★ 新 schema：任务可挂阶段
  status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  estimate: z.number().optional(), // 兼容旧表单字段（新 schema 暂无对应列，忽略）
  type: z.string().optional(), // 兼容旧表单字段（忽略）
})

/**
 * /api/tasks —— 依据《开发文档-项目管理系统重构》§7.6
 *
 * GET /api/tasks?projectId=&phaseId=&mine=1&page=&limit=  任务 view（范围过滤，分页）
 *   - 可见性（2026-08-21 权限 V2 修复）：非 ADMIN 仅见所属项目任务（成员过滤），
 *     与「项目列表仅成员可见」口径一致，堵住非成员枚举任务泄露
 *   - 筛选：projectId（项目内）/ phaseId（阶段内）/ mine=1（我负责的）/ search / status
 * POST /api/tasks  项目成员建任务（兼容旧入口；阶段下建任务走 §7.6 的
 *   POST /phases/:id/tasks，那边挂阶段 assign 权限）
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const userData = requireAuth(request)

  const { page, limit, skip } = parsePagination(request, 10)
  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') || ''
  const projectId = searchParams.get('projectId')
  const phaseId = searchParams.get('phaseId')
  const mine = searchParams.get('mine') === '1' || searchParams.get('mine') === 'true'
  const status = searchParams.get('status')
  const assigneeId = searchParams.get('assigneeId')

  // 可见性（2026-08-21 修复）：非 ADMIN 仅见所属项目任务（复用项目成员过滤）
  const visibleFilter = await visibleTaskFilter(userData.userId, userData.role)
  // P2-7 修复：状态白名单校验后再赋值（替代 as never）
  const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED'] as const
  const statusValid = status && (TASK_STATUSES as readonly string[]).includes(status) ? (status as (typeof TASK_STATUSES)[number]) : undefined
  const where = {
    ...(search && {
      OR: [{ title: { contains: search } }, { description: { contains: search } }],
    }),
    ...(projectId && { projectId }),
    ...(phaseId && { phaseId }),
    ...(mine && { assigneeId: userData.userId }),
    ...(statusValid && { status: statusValid }),
    ...(assigneeId && { assigneeId }),
    ...visibleFilter, // 权限 V2：非 ADMIN 仅成员项目
  }

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        phase: { select: { id: true, code: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
          },
        },
        creator: { select: { id: true, name: true, email: true } },
        _count: {
          select: {
            annotations: true,
            revisions: true,
            comments: true,
          },
        },
      },
      orderBy: [{ id: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.task.count({ where }),
  ])

  // 阶段文件统计（2026-08-21）：按 projectId×phaseCode 聚合，任务行显示「文件 X/Y 已提交」
  let fileStatsByPhase = new Map<string, { submitted: number; total: number }>()
  if (tasks.length > 0) {
    const withPhase = tasks.filter((t) => t.phase && t.phase.code)
    if (withPhase.length > 0) {
      const groups = await prisma.fileRequirement.groupBy({
        by: ['projectId', 'phaseCode', 'status'],
        where: {
          projectId: { in: Array.from(new Set(withPhase.map((t) => t.projectId))) },
          phaseCode: { in: Array.from(new Set(withPhase.map((t) => t.phase!.code!))) },
        },
        _count: { _all: true },
      })
      const map = new Map<string, { submitted: number; total: number }>()
      for (const g of groups) {
        const key = `${g.projectId}:${g.phaseCode}`
        const cur = map.get(key) ?? { submitted: 0, total: 0 }
        cur.total += g._count._all
        if (g.status === 'SUBMITTED' || g.status === 'APPROVED' || g.status === 'REVIEWING') {
          cur.submitted += g._count._all
        }
        map.set(key, cur)
      }
      fileStatsByPhase = map
    }
  }

  // 项目总进度（2026-08-21：Phase 均值，任务总览进度条用）
  const projIds = Array.from(new Set(tasks.map((t) => t.projectId)))
  let progressByProject = new Map<string, number>()
  if (projIds.length > 0) {
    const phases = await prisma.phase.findMany({
      where: { projectId: { in: projIds }, status: { not: 'SKIPPED' } },
      select: { projectId: true, progress: true },
    })
    const sums = new Map<string, { sum: number; n: number }>()
    for (const ph of phases) {
      const cur = sums.get(ph.projectId) ?? { sum: 0, n: 0 }
      cur.sum += ph.progress
      cur.n++
      sums.set(ph.projectId, cur)
    }
    for (const [pid, v] of Array.from(sums.entries())) {
      progressByProject.set(pid, v.n > 0 ? Math.round(v.sum / v.n) : 0)
    }
  }

  const items = tasks.map((t) => ({
    ...t,
    // 阶段文件提交进度（无阶段/无条目时 null）
    phaseFileStats:
      t.phase && t.phase.code
        ? (fileStatsByPhase.get(`${t.projectId}:${t.phase.code}`) ?? null)
        : null,
    // 项目总进度（总览进度条用）
    projectProgress: progressByProject.get(t.projectId) ?? 0,
  }))

  return okPage(items, page, limit, total)
})

/**
 * POST /api/tasks → 创建任务
 * P0-3 适配 schema v1.1：任务 key / 看板列逻辑移除，支持挂阶段（phaseId）
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const userData = requireAuth(request)

  const body = await request.json()
  const validatedData = createTaskSchema.parse(body)

  // 权限（2026-08-21 修复 P1-1）：与阶段下建任务口径统一——走权限引擎 assign 校验，
  // 堵住 VIEWER（只读角色）也能建任务的越权
  await requireCan(userData.userId, 'assign', { type: 'PROJECT', id: validatedData.projectId })

  const project = await prisma.project.findUnique({
    where: { id: validatedData.projectId },
    select: { id: true, code: true, name: true, isArchived: true },
  })
  if (!project) {
    throw ApiError.notFound('项目不存在')
  }
  if (project.isArchived) {
    throw new ApiError(403, '项目已归档，无法创建任务')
  }

  // 阶段校验（可选挂载）
  if (validatedData.phaseId) {
    const phase = await prisma.phase.findUnique({
      where: { id: validatedData.phaseId },
      select: { id: true, projectId: true },
    })
    if (!phase || phase.projectId !== validatedData.projectId) {
      throw ApiError.badRequest('阶段不存在或不属于该项目')
    }
  }

  const task = await prisma.$transaction(async (tx) => {
    const createdTask = await tx.task.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        projectId: validatedData.projectId,
        phaseId: validatedData.phaseId,
        status: validatedData.status || 'TODO',
        priority: validatedData.priority || 'MEDIUM',
        assigneeId: validatedData.assigneeId,
        creatorId: userData.userId,
        dueDate: validatedData.dueDate ? new Date(validatedData.dueDate) : null,
      },
      include: {
        phase: { select: { id: true, code: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
          },
        },
        creator: { select: { id: true, name: true, email: true } },
      },
    })

    // §7.9：任务新建即指派 → 给新 assignee 写待办 + 通知（全源聚合）
    if (validatedData.assigneeId) {
      await ensureTaskTodo(tx, {
        assigneeId: validatedData.assigneeId,
        taskId: createdTask.id,
        title: createdTask.title,
        projectId: validatedData.projectId,
        dueDate: createdTask.dueDate,
        priority: createdTask.priority,
      })
      await tx.notification.create({
        data: {
          userId: validatedData.assigneeId,
          ...taskAssignedPayload(createdTask.title, validatedData.projectId, createdTask.id),
        },
      })
    }

    return createdTask
  })

  // P2-2 通知集成：任务创建 → 企业微信/钉钉 webhook（fire-and-forget，失败绝不影响主流程）
  void notifyTaskCreated({
    projectId: validatedData.projectId,
    projectName: project.name,
    taskId: task.id,
    taskTitle: task.title,
    operatorName: task.creator?.name,
    assigneeName: task.assignee?.name ?? undefined,
  }).catch(() => {})
  if (validatedData.assigneeId) {
    void notifyTaskAssigned({
      projectId: validatedData.projectId,
      projectName: project.name,
      taskId: task.id,
      taskTitle: task.title,
      operatorName: task.creator?.name,
      assigneeName: task.assignee?.name ?? undefined,
    }).catch(() => {})
  }

  return created(task, '任务创建成功')
})
