// POST /api/ai/summarize — AI 数据汇总（项目状态汇总 / 我的工作汇总）
// 设计：docs/设计方案-AI智能助手.md §五。只读：数据权限跟随（project 套 visibleProjectFilter，mine 套 visibleTaskFilter）。
// body: { type: 'project'|'mine', projectId? }  →  { type, summary, stats }
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth, ApiError } from '@/lib/api-helpers'
import { prisma } from '@/lib/prisma'
import { visibleProjectFilter, visibleTaskFilter } from '@/lib/data-visibility'
import { computeProjectProgress } from '@/lib/phase-engine'
import { chatCompletion } from '@/lib/ai/mimo'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'
import { assertAiConfigured, miMoToApiError } from '@/lib/ai/api-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const BodySchema = z.object({
  type: z.enum(['project', 'mine']),
  projectId: z.string().min(1).optional(),
})

/** 项目汇总：拉阶段/任务/文件统计（不含金额，规避财务脱敏面），交 MiMo 归纳 */
async function summarizeProject(userId: string, role: string, projectId: string) {
  const visWhere = await visibleProjectFilter(userId, role)
  // 不可见 = 不可达：与列表同口径过滤，避免猜 URL 越权
  const project = await prisma.project.findFirst({
    where: { AND: [visWhere, { id: projectId }] },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      priority: true,
      plannedStart: true,
      plannedEnd: true,
      isArchived: true,
      customer: { select: { name: true } },
    },
  })
  if (!project) throw ApiError.notFound('项目不存在或您无权限查看该项目')

  const [phases, taskStats, fileStats, progress] = await Promise.all([
    prisma.phase.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      select: { code: true, name: true, status: true, plannedStart: true, plannedEnd: true },
      take: 30,
    }),
    prisma.task.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    prisma.fileRequirement.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    computeProjectProgress(projectId),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const prompt = [
    '你是项目管理系统的 AI 助手。基于下方真实系统数据，输出项目状态汇总。',
    '要求：',
    '1. ≤5 行要点（每行一个维度：总体进度/阶段推进/任务/文件交付/时间风险），先结论后细节',
    '2. 末尾单列「风险提示」：仅基于数据中的客观信号（逾期/停滞/积压/临近截止），没有则写「暂无明显风险」',
    `3. 今天是 ${today}。严禁编造数据中不存在的信息。用简体中文。`,
    '',
    '项目数据（JSON）：',
    JSON.stringify({
      project: {
        code: project.code,
        name: project.name,
        status: project.status,
        priority: project.priority,
        archived: project.isArchived,
        customer: project.customer?.name ?? null,
        plannedStart: project.plannedStart?.toISOString() ?? null,
        plannedEnd: project.plannedEnd?.toISOString() ?? null,
        progressPercent: progress,
      },
      phases: phases.map((p) => ({
        code: p.code,
        name: p.name,
        status: p.status,
        plannedEnd: p.plannedEnd?.toISOString() ?? null,
      })),
      taskStats: Object.fromEntries(taskStats.map((t) => [t.status, t._count._all])),
      fileStats: Object.fromEntries(fileStats.map((f) => [f.status, f._count._all])),
    }),
  ].join('\n')

  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: '请汇总该项目当前状态' },
      ],
      { temperature: 0.3, max_completion_tokens: 1536, timeoutMs: 45000 },
    )
    return {
      type: 'project' as const,
      projectId: project.id,
      projectLabel: `${project.code} ${project.name}`,
      summary: res.content?.trim() || 'AI 未返回内容，请稍后重试',
      stats: {
        progressPercent: progress,
        taskStats: Object.fromEntries(taskStats.map((t) => [t.status, t._count._all])),
        fileStats: Object.fromEntries(fileStats.map((f) => [f.status, f._count._all])),
        phaseCount: phases.length,
      },
    }
  } catch (err) {
    throw miMoToApiError(err)
  }
}

/** 我的工作汇总：未完成待办 + 我负责/创建的未完结任务（可见范围跟随） */
async function summarizeMine(userId: string, role: string) {
  const [todos, taskWhere] = await Promise.all([
    prisma.todoItem.findMany({
      where: { userId, doneAt: null },
      take: 20,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      select: { title: true, priority: true, dueAt: true, sourceType: true },
    }),
    visibleTaskFilter(userId, role),
  ])
  const tasks = await prisma.task.findMany({
    where: {
      ...taskWhere,
      status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] },
      OR: [{ assigneeId: userId }, { creatorId: userId }],
    },
    take: 20,
    orderBy: [{ dueDate: 'asc' }, { id: 'desc' }],
    select: {
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      project: { select: { code: true, name: true } },
    },
  })

  const today = new Date().toISOString().slice(0, 10)
  const prompt = [
    '你是项目管理系统的 AI 助手。基于下方该用户的真实待办与任务数据，输出个人工作汇总。',
    '要求：',
    '1. ≤5 行要点：工作量概览 / 最紧急事项（含截止日期）/ 逾期项 / 建议优先处理顺序',
    `2. 今天是 ${today}；截止日期早于今天且未完成 = 逾期。严禁编造数据。用简体中文。`,
    '',
    '我的数据（JSON）：',
    JSON.stringify({
      openTodos: todos.map((t) => ({
        title: t.title,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
      })),
      openTasks: tasks.map((t) => ({
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate?.toISOString() ?? null,
        project: t.project ? `${t.project.code} ${t.project.name}` : null,
      })),
    }),
  ].join('\n')

  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: '请汇总我的工作' },
      ],
      { temperature: 0.3, max_completion_tokens: 1536, timeoutMs: 45000 },
    )
    return {
      type: 'mine' as const,
      summary: res.content?.trim() || 'AI 未返回内容，请稍后重试',
      stats: { openTodos: todos.length, openTasks: tasks.length },
    }
  } catch (err) {
    throw miMoToApiError(err)
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const rl = checkAiRateLimit(authUser.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()
  const { type, projectId } = BodySchema.parse(await request.json())

  if (type === 'project') {
    if (!projectId) throw ApiError.badRequest('type=project 时 projectId 必填')
    const result = await summarizeProject(authUser.userId, authUser.role, projectId)
    return ok(result)
  }
  const result = await summarizeMine(authUser.userId, authUser.role)
  return ok(result)
})
