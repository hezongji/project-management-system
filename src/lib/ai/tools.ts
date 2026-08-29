// AI 工具注册表 + 执行器（权限跟随铁律：所有工具内套用 data-visibility 过滤，绝不裸查）
// 每个工具接收 AuthUser，套用 visibleXxxFilter / maskXxx，返回只读 JSON 字符串给模型消费。
import { prisma } from '../prisma'
import type { AuthUser } from '../auth'
import {
  visibleProjectFilter,
  visibleTaskFilter,
  visiblePurchaseOrderFilter,
  canViewFinance,
  canViewPurchaseFinanceOf,
  getUserDeptName,
  maskFinance,
  maskPurchaseFinance,
} from '../data-visibility'
import { visibleRequirementFilter } from '../permission'
import { computeProjectProgress } from '../phase-engine'
import type { MiMoChatOptions } from './mimo'

/** 工具定义类型（与 MiMo 客户端 tools 参数一致） */
export type AiToolDef = NonNullable<MiMoChatOptions['tools']>[number]

/** 单个工具返回给模型的上限字符数（防 context 膨胀） */
const MAX_TOOL_JSON = 8000

// ───────────────────────── 工具 schema（OpenAI function 格式）─────────────────────────

export const AI_TOOLS: AiToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'query_my_projects',
      description: '列出当前用户可见的项目（含编号/名称/状态/进度）。无参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_project_detail',
      description:
        '查某项目详情：阶段进度/成员数/任务统计/文件统计。参数 projectId（必填）。项目不存在或无权限时返回 visible:false。',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 id' } },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_tasks',
      description:
        '查任务列表。参数：projectId（可选，限定某项目）、mine（可选，true=只看我负责/创建的）。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '限定项目 id（可选）' },
          mine: { type: 'boolean', description: '只看我的任务（可选）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_files',
      description:
        '查文件交付条目（名称/编号/状态/截止/责任人）。参数 projectId（可选，限定某项目）。',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '限定项目 id（可选）' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_purchase_orders',
      description:
        '查采购订单（编号/标题/类别/状态/到货进度/金额——金额按权限可能为 null）。参数 projectId、status（可选）。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '限定项目 id（可选）' },
          status: {
            type: 'string',
            description:
              '按状态过滤（可选）：DRAFT/CONTRACT_PENDING/ORDERED/PARTIAL/COMPLETED/CANCELLED 等',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_my_todos',
      description: '列出当前用户的未完成待办（含优先级/截止时间/链接）。无参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_stats',
      description:
        '查工作台统计：可见项目数（总/活跃/完成）、任务数（总/完成/逾期）、我的待办数、近期项目。无参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]

// ───────────────────────── 工具执行器 ─────────────────────────

/**
 * 执行 AI 工具调用。返回给模型的 JSON 字符串（只读）。
 * 工具内部错误不抛出（转为 { error }  JSON，让模型优雅解释）；
 * 未实现工具名 → 抛错（由上层转为友好 tool 回复）。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  authUser: AuthUser,
): Promise<string> {
  try {
    switch (name) {
      case 'query_my_projects':
        return await queryMyProjects(authUser)
      case 'query_project_detail':
        return await queryProjectDetail(authUser, str(args.projectId))
      case 'query_tasks':
        return await queryTasks(authUser, str(args.projectId), args.mine === true)
      case 'query_files':
        return await queryFiles(authUser, str(args.projectId))
      case 'query_purchase_orders':
        return await queryPurchaseOrders(authUser, str(args.projectId), str(args.status))
      case 'query_my_todos':
        return await queryMyTodos(authUser)
      case 'query_stats':
        return await queryStats(authUser)
      default:
        throw new Error(`工具未实现: ${name}`)
    }
  } catch (err) {
    return JSON.stringify({
      error: true,
      message: err instanceof Error ? err.message : '工具执行失败',
    })
  }
}

// ───────────────────────── 内部实现 ─────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 超长截断保护：>8000 字符时砍掉尾部并标注 */
function capJson(payload: Record<string, unknown>): string {
  let json = JSON.stringify(payload)
  if (json.length <= MAX_TOOL_JSON) return json
  payload.truncated = true
  payload.note = '结果过长已截断，建议缩小范围（如限定 projectId）'
  json = JSON.stringify(payload)
  if (json.length <= MAX_TOOL_JSON) return json
  return json.slice(0, MAX_TOOL_JSON)
}

async function queryMyProjects(authUser: AuthUser): Promise<string> {
  const where = await visibleProjectFilter(authUser.userId, authUser.role)
  const projects = await prisma.project.findMany({
    where,
    take: 20,
    orderBy: { createdAt: 'desc' },
    select: { id: true, code: true, name: true, status: true, isArchived: true },
  })
  const withProgress = await Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      archived: p.isArchived,
      progressPercent: await computeProjectProgress(p.id),
    })),
  )
  return capJson({ total: withProgress.length, projects: withProgress })
}

async function queryProjectDetail(authUser: AuthUser, projectId: string | null): Promise<string> {
  if (!projectId) return capJson({ error: true, message: '缺少 projectId' })
  const visWhere = await visibleProjectFilter(authUser.userId, authUser.role)
  // 不可见 = 不可达：详情先套列表同口径过滤
  const project = await prisma.project.findFirst({
    where: { AND: [visWhere, { id: projectId }] },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      priority: true,
      location: true,
      signedAt: true,
      plannedStart: true,
      plannedEnd: true,
      actualEnd: true,
      isArchived: true,
      description: true,
      amount: true,
      customer: { select: { name: true } },
      members: { select: { userId: true, role: true, user: { select: { name: true } } }, take: 50 },
    },
  })
  if (!project) {
    return capJson({ visible: false, message: '项目不存在或您无权限查看该项目' })
  }
  const [phases, taskStats, fileStats, progress] = await Promise.all([
    prisma.phase.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      select: { code: true, name: true, status: true, plannedStart: true, plannedEnd: true },
      take: 30,
    }),
    prisma.task.groupBy({
      by: ['status'],
      where: { projectId },
      _count: { _all: true },
    }),
    prisma.fileRequirement.groupBy({
      by: ['status'],
      where: { projectId },
      _count: { _all: true },
    }),
    computeProjectProgress(projectId),
  ])
  // 金额脱敏：与项目 API 同口径（ADMIN/财务部/项目 OWNER/MANAGER）
  const [deptName, myMembership] = await Promise.all([
    getUserDeptName(authUser.userId),
    prisma.projectMember.findFirst({
      where: { projectId, userId: authUser.userId },
      select: { role: true },
    }),
  ])
  const finOk = canViewFinance(authUser.role, deptName, myMembership?.role ?? null)
  const masked = maskFinance({ amount: project.amount }, finOk)
  return capJson({
    visible: true,
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      status: project.status,
      priority: project.priority,
      archived: project.isArchived,
      location: project.location,
      signedAt: project.signedAt?.toISOString() ?? null,
      plannedStart: project.plannedStart?.toISOString() ?? null,
      plannedEnd: project.plannedEnd?.toISOString() ?? null,
      actualEnd: project.actualEnd?.toISOString() ?? null,
      description: project.description,
      amount: project.amount ? Number(masked.amount) : null,
      customerName: project.customer?.name ?? null,
      memberCount: project.members.length,
      members: project.members
        .slice(0, 15)
        .map((m) => ({ name: m.user.name, role: m.role, title: m.role })),
      progressPercent: progress,
    },
    phases: phases.map((ph) => ({
      code: ph.code,
      name: ph.name,
      status: ph.status,
      plannedStart: ph.plannedStart?.toISOString() ?? null,
      plannedEnd: ph.plannedEnd?.toISOString() ?? null,
    })),
    taskStats: Object.fromEntries(taskStats.map((t) => [t.status, t._count._all])),
    fileStats: Object.fromEntries(fileStats.map((f) => [f.status, f._count._all])),
  })
}

async function queryTasks(
  authUser: AuthUser,
  projectId: string | null,
  mine: boolean,
): Promise<string> {
  const visWhere = await visibleTaskFilter(authUser.userId, authUser.role)
  const where: Record<string, unknown> = { ...visWhere }
  if (projectId) where.projectId = projectId
  if (mine) where.OR = [{ assigneeId: authUser.userId }, { creatorId: authUser.userId }]
  const [total, tasks] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      take: 30,
      orderBy: [{ dueDate: 'asc' }, { id: 'desc' }],
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        completedAt: true,
        assignee: { select: { name: true } },
        project: { select: { code: true, name: true } },
        phase: { select: { code: true, name: true } },
      },
    }),
  ])
  return capJson({
    total,
    shown: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString() ?? null,
      assignee: t.assignee?.name ?? null,
      project: t.project ? `${t.project.code} ${t.project.name}` : null,
      phase: t.phase ? `${t.phase.code} ${t.phase.name}` : null,
    })),
  })
}

async function queryFiles(authUser: AuthUser, projectId: string | null): Promise<string> {
  // 文件条目可见性复用 permission.visibleRequirementFilter（PUBLIC/RESTRICTED/PRIVATE 三档）
  const visWhere = await visibleRequirementFilter(authUser.userId)
  const where: Record<string, unknown> = { ...visWhere }
  if (projectId) where.projectId = projectId
  const [total, files] = await Promise.all([
    prisma.fileRequirement.count({ where }),
    prisma.fileRequirement.findMany({
      where,
      take: 30,
      orderBy: [{ dueDate: 'asc' }, { id: 'desc' }],
      select: {
        name: true,
        code: true,
        status: true,
        required: true,
        dueDate: true,
        phaseCode: true,
        owner: { select: { name: true } },
        project: { select: { code: true, name: true } },
      },
    }),
  ])
  return capJson({
    total,
    shown: files.length,
    files: files.map((f) => ({
      name: f.name,
      code: f.code,
      status: f.status,
      required: f.required,
      dueDate: f.dueDate?.toISOString() ?? null,
      phase: f.phaseCode,
      owner: f.owner?.name ?? null,
      project: f.project ? `${f.project.code} ${f.project.name}` : null,
    })),
  })
}

async function queryPurchaseOrders(
  authUser: AuthUser,
  projectId: string | null,
  status: string | null,
): Promise<string> {
  const visWhere = await visiblePurchaseOrderFilter(authUser.userId, authUser.role)
  const where: Record<string, unknown> = { ...visWhere }
  if (projectId) where.projectId = projectId
  if (status) where.status = status
  const finOk = await canViewPurchaseFinanceOf(authUser.userId, authUser.role)
  const [total, orders] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({
      where,
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        title: true,
        category: true,
        status: true,
        isSupplementary: true,
        supplementaryReason: true,
        orderDate: true,
        plannedArrivalDate: true,
        amount: true,
        settlementAmount: true,
        remark: true,
        project: { select: { code: true, name: true } },
        supplier: { select: { name: true } },
        items: {
          select: { name: true, quantity: true, receivedQty: true },
          take: 15,
        },
        arrivals: { select: { batchNo: true, arrivalDate: true, status: true }, take: 10 },
      },
    }),
  ])
  const rows = orders.map((o) =>
    maskPurchaseFinance(
      {
        code: o.code,
        title: o.title,
        category: o.category,
        status: o.status,
        isSupplementary: o.isSupplementary,
        supplementaryReason: o.supplementaryReason,
        orderDate: o.orderDate?.toISOString() ?? null,
        plannedArrivalDate: o.plannedArrivalDate?.toISOString() ?? null,
        amount: o.amount ? Number(o.amount) : null,
        settlementAmount: o.settlementAmount ? Number(o.settlementAmount) : null,
        remark: o.remark,
        project: o.project ? `${o.project.code} ${o.project.name}` : null,
        supplier: o.supplier?.name ?? null,
        items: o.items.map((it) => ({
          name: it.name,
          quantity: it.quantity ? Number(it.quantity) : null,
          receivedQty: it.receivedQty ? Number(it.receivedQty) : 0,
        })),
        arrivals: o.arrivals.map((a) => ({
          batchNo: a.batchNo,
          arrivalDate: a.arrivalDate.toISOString(),
          status: a.status,
        })),
      },
      finOk,
    ),
  )
  return capJson({
    total,
    shown: rows.length,
    financeVisible: finOk,
    note: finOk ? null : '当前用户无采购金额权限，金额字段为 null',
    orders: rows,
  })
}

async function queryMyTodos(authUser: AuthUser): Promise<string> {
  const todos = await prisma.todoItem.findMany({
    where: { userId: authUser.userId, doneAt: null },
    take: 20,
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      title: true,
      priority: true,
      dueAt: true,
      link: true,
      sourceType: true,
      createdAt: true,
    },
  })
  return capJson({
    total: todos.length,
    todos: todos.map((t) => ({
      ...t,
      dueAt: t.dueAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
  })
}

async function queryStats(authUser: AuthUser): Promise<string> {
  // 与 /api/dashboard/stats 同口径：可见项目范围统计，ADMIN 全量
  const memberScope = await visibleProjectFilter(authUser.userId, authUser.role)
  let taskScope: Record<string, unknown> = {}
  if (authUser.role !== 'ADMIN') {
    const myProjects = await prisma.project.findMany({
      where: memberScope,
      select: { id: true },
    })
    const ids = myProjects.map((p) => p.id)
    taskScope = ids.length > 0 ? { projectId: { in: ids } } : { projectId: { in: [] } }
  }
  const [totalProjects, activeProjects, completedProjects, totalTasks, completedTasks, overdueTasks, myTodoCount, recentProjects] =
    await Promise.all([
      prisma.project.count({ where: memberScope }),
      prisma.project.count({ where: { ...memberScope, status: 'ACTIVE' } }),
      prisma.project.count({ where: { ...memberScope, status: 'COMPLETED' } }),
      prisma.task.count({ where: taskScope }),
      prisma.task.count({ where: { ...taskScope, status: 'DONE' } }),
      prisma.task.count({
        where: { ...taskScope, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
      }),
      prisma.todoItem.count({ where: { userId: authUser.userId, doneAt: null } }),
      prisma.project.findMany({
        where: memberScope,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { code: true, name: true, status: true },
      }),
    ])
  return capJson({
    projects: { total: totalProjects, active: activeProjects, completed: completedProjects },
    tasks: { total: totalTasks, done: completedTasks, overdue: overdueTasks },
    myOpenTodos: myTodoCount,
    recentProjects,
  })
}
