import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { visibleProjectFilter, visibleTaskFilter } from '@/lib/data-visibility'
import type { AuthUser } from '@/lib/auth'

/**
 * MCP 工具注册（学 Kaneo：内置 HTTP MCP 端点，让 Claude/Cursor/Codex 直接管理项目与任务）
 *
 * 设计原则：
 *   1. 复用现有数据可见性过滤（visibleProjectFilter / visibleTaskFilter），
 *      非 ADMIN 只能看到自己所属项目，不越权枚举。
 *   2. 写操作（create/update）校验项目成员身份，非成员/非 ADMIN 拒绝。
 *   3. 结果统一 JSON 文本，isError 标记失败，便于 AI 客户端解读。
 */

// ── 枚举（与 prisma/schema.prisma 严格对齐）──
const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED'] as const
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const
const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const

// ── 结果类型 ──
type TextContent = { type: 'text'; text: string }
type McpToolResult = { content: TextContent[]; isError?: boolean }

function textResult(data: unknown, isError = false): McpToolResult {
  const text =
    typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? '')
  return { content: [{ type: 'text', text }], isError }
}

function run(fn: () => Promise<unknown>): Promise<McpToolResult> {
  return fn()
    .then((data) => textResult(data))
    .catch((e: unknown) =>
      textResult({ error: e instanceof Error ? e.message : String(e) }, true),
    )
}

/** 写操作权限：ADMIN 或项目成员 */
async function assertProjectMember(user: AuthUser, projectId: string): Promise<void> {
  if (user.role === 'ADMIN') return
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.userId } },
  })
  if (!member) throw new Error('无权限操作该项目（仅项目成员或管理员）')
}

// ── 精简投影 ──
const projectSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  priority: true,
  location: true,
  plannedStart: true,
  plannedEnd: true,
  isArchived: true,
  _count: { select: { tasks: true, members: true } },
} as const

const taskInclude = {
  project: { select: { id: true, code: true, name: true } },
  phase: { select: { id: true, code: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true } },
} as const

// ── input schema（z.object，类型安全）──
const listProjectsSchema = z.object({
  search: z.string().optional().describe('按名称/编号/客户模糊搜索'),
  status: z.enum(PROJECT_STATUSES).optional().describe('项目状态筛选'),
  limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20'),
})

const listTasksSchema = z.object({
  projectId: z.string().optional().describe('按项目筛选'),
  status: z.enum(TASK_STATUSES).optional().describe('任务状态筛选'),
  assigneeId: z.string().optional().describe('按负责人筛选'),
  search: z.string().optional().describe('按标题/描述模糊搜索'),
  limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20'),
})

const createTaskSchema = z.object({
  projectId: z.string().min(1).describe('所属项目 ID'),
  title: z.string().min(1).describe('任务标题'),
  description: z.string().optional().describe('任务描述'),
  phaseId: z.string().optional().describe('所属阶段 ID'),
  status: z.enum(TASK_STATUSES).optional().describe('状态，默认 TODO'),
  priority: z.enum(TASK_PRIORITIES).optional().describe('优先级，默认 MEDIUM'),
  assigneeId: z.string().optional().describe('负责人用户 ID'),
  dueDate: z.string().optional().describe('截止日期（ISO 8601，如 2026-09-15）'),
})

const updateTaskSchema = z.object({
  taskId: z.string().min(1).describe('任务 ID'),
  title: z.string().optional().describe('新标题'),
  description: z.string().nullable().optional().describe('新描述（传 null 清空）'),
  status: z.enum(TASK_STATUSES).optional().describe('新状态'),
  priority: z.enum(TASK_PRIORITIES).optional().describe('新优先级'),
  assigneeId: z.string().nullable().optional().describe('新负责人（传 null 取消指派）'),
  dueDate: z.string().nullable().optional().describe('新截止日期（传 null 清除）'),
})

/**
 * 注册全部 MCP 工具到指定 server（绑定当前用户，权限随用户隔离）。
 */
export function registerMcpTools(server: McpServer, user: AuthUser): void {
  // 1. 列出项目
  server.registerTool(
    'list_projects',
    { description: '列出当前用户可见的项目（含搜索、状态筛选）。非管理员仅返回自己参与的项目。', inputSchema: listProjectsSchema },
    async (args) => {
      return run(async () => {
        const vis = await visibleProjectFilter(user.userId, user.role)
        return prisma.project.findMany({
          where: {
            ...vis,
            ...(args.status ? { status: args.status } : {}),
            ...(args.search
              ? {
                  OR: [
                    { name: { contains: args.search } },
                    { code: { contains: args.search } },
                    { customer: { name: { contains: args.search } } },
                  ],
                }
              : {}),
          },
          select: projectSelect,
          orderBy: { updatedAt: 'desc' },
          take: args.limit ?? 20,
        })
      })
    },
  )

  // 2. 项目详情
  server.registerTool(
    'get_project',
    {
      description: '获取单个项目详情（含阶段数、任务数、成员数等统计）',
      inputSchema: z.object({ projectId: z.string().min(1).describe('项目 ID') }),
    },
    async (args) => {
      return run(async () => {
        const vis = await visibleProjectFilter(user.userId, user.role)
        const project = await prisma.project.findFirst({
          where: { AND: [{ id: args.projectId }, vis] },
          select: {
            ...projectSelect,
            phases: { select: { id: true, code: true, name: true, status: true } },
            members: {
              select: { role: true, title: true, user: { select: { id: true, name: true, email: true } } },
            },
          },
        })
        if (!project) throw new Error('项目不存在或无权访问')
        return project
      })
    },
  )

  // 3. 列出任务
  server.registerTool(
    'list_tasks',
    {
      description: '列出当前用户可见的任务（按项目/状态/负责人/关键词筛选）。非管理员仅返回自己参与项目的任务。',
      inputSchema: listTasksSchema,
    },
    async (args) => {
      return run(async () => {
        const vis = await visibleTaskFilter(user.userId, user.role)
        return prisma.task.findMany({
          where: {
            ...vis,
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.assigneeId ? { assigneeId: args.assigneeId } : {}),
            ...(args.search
              ? { OR: [{ title: { contains: args.search } }, { description: { contains: args.search } }] }
              : {}),
          },
          include: taskInclude,
          orderBy: { dueDate: 'asc' },
          take: args.limit ?? 20,
        })
      })
    },
  )

  // 4. 任务详情
  server.registerTool(
    'get_task',
    {
      description: '获取单个任务详情（含所属项目/阶段/负责人/评论与修订统计）',
      inputSchema: z.object({ taskId: z.string().min(1).describe('任务 ID') }),
    },
    async (args) => {
      return run(async () => {
        const vis = await visibleTaskFilter(user.userId, user.role)
        const task = await prisma.task.findFirst({
          where: { AND: [{ id: args.taskId }, vis] },
          include: {
            ...taskInclude,
            _count: { select: { comments: true, annotations: true, revisions: true } },
          },
        })
        if (!task) throw new Error('任务不存在或无权访问')
        return task
      })
    },
  )

  // 5. 我的待办
  server.registerTool(
    'list_my_tasks',
    {
      description: '列出分配给当前用户的未完成任务（我的待办）',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20'),
        onlyPending: z.boolean().optional().describe('仅返回未完成（非 DONE/CANCELLED），默认 true'),
      }),
    },
    async (args) => {
      return run(async () => {
        const onlyPending = args.onlyPending ?? true
        return prisma.task.findMany({
          where: {
            assigneeId: user.userId,
            ...(onlyPending ? { status: { notIn: ['DONE', 'CANCELLED'] } } : {}),
          },
          include: taskInclude,
          orderBy: { dueDate: 'asc' },
          take: args.limit ?? 20,
        })
      })
    },
  )

  // 6. 创建任务
  server.registerTool(
    'create_task',
    {
      description: '在项目中创建任务（需为项目成员或管理员）',
      inputSchema: createTaskSchema,
    },
    async (args) => {
      return run(async () => {
        await assertProjectMember(user, args.projectId)
        const task = await prisma.task.create({
          data: {
            projectId: args.projectId,
            title: args.title,
            creatorId: user.userId,
            ...(args.description ? { description: args.description } : {}),
            ...(args.phaseId ? { phaseId: args.phaseId } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.priority ? { priority: args.priority } : {}),
            ...(args.assigneeId ? { assigneeId: args.assigneeId } : {}),
            ...(args.dueDate ? { dueDate: new Date(args.dueDate) } : {}),
          },
          include: taskInclude,
        })
        return task
      })
    },
  )

  // 7. 更新任务
  server.registerTool(
    'update_task',
    {
      description: '更新任务（标题/描述/状态/优先级/负责人/截止日期）。仅项目成员或管理员可操作。',
      inputSchema: updateTaskSchema,
    },
    async (args) => {
      return run(async () => {
        const existing = await prisma.task.findUnique({ where: { id: args.taskId } })
        if (!existing) throw new Error('任务不存在')
        await assertProjectMember(user, existing.projectId)

        const data: Record<string, unknown> = {}
        if (args.title !== undefined) data.title = args.title
        if (args.description !== undefined) data.description = args.description
        if (args.status !== undefined) data.status = args.status
        if (args.priority !== undefined) data.priority = args.priority
        if (args.assigneeId !== undefined) data.assigneeId = args.assigneeId
        if (args.dueDate !== undefined) data.dueDate = args.dueDate ? new Date(args.dueDate) : null

        const task = await prisma.task.update({
          where: { id: args.taskId },
          data,
          include: taskInclude,
        })
        return task
      })
    },
  )
}
