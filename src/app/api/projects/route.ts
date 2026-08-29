/**
 * /api/projects —— 依据《开发文档-项目管理系统重构》§7.4
 *
 * GET  /api/projects   登录         我可见项目（权限过滤 + 分页 + 搜索 + 状态筛选）
 * POST /api/projects   PROJECT_MANAGER（ADMIN 直通）  创建项目（事务内实例化流程，§7.4 五动作）
 *
 * 实现说明：
 *  - POST 走 lib/phase-engine.instantiateProject（事务五动作：Project/Phase/FileCatalog
 *    +FileRequirement/会话+欢迎消息+NOTIFY im_events，任一失败全回滚）
 *  - 项目编号省略时按「DEMO+签约年后两位+3位流水」自动生成（作废编号不复用）
 *  - GET 可见性（2026-08-20 台账公开决策）：登录即可见全部项目（几十人公司台账
 *    公开，列表只读放开）；写操作仍走权限引擎 requireCan/requireRole 兜底
 *  - 响应项目对象附加 myRole（当前用户在项目内的角色；ADMIN 为 'ADMIN'）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  okPage,
  created,
  parsePagination,
  requireAuth,
  requireRole,
  ApiError,
} from '@/lib/api-helpers'
import { instantiateProject, EngineError } from '@/lib/phase-engine'
import {
  visibleProjectFilter,
  canViewFinance,
  maskFinance,
} from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

// ───────────────────────────── GET：我可见项目 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const { page, limit, skip } = parsePagination(request, 20)
  const { searchParams } = new URL(request.url)
  const search = (searchParams.get('search') || '').trim()

  const validStatus = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const
  type StatusFilter = (typeof validStatus)[number]
  const rawStatus = searchParams.get('status')
  const statusFilter: StatusFilter | undefined =
    rawStatus && (validStatus as readonly string[]).includes(rawStatus)
      ? (rawStatus as StatusFilter)
      : undefined

  // 可见性（2026-08-21 权限 V2 决策）：项目列表仅项目成员可见，ADMIN 全量；
  // 财务字段（amount/contractNo）按 canViewFinance 脱敏
  const visibilityWhere = await visibleProjectFilter(user.userId, user.role)
  // 非财务权限者搜索剔除 contractNo（P2-4 修复：防合同号探测项目存在性）
  const deptRow0 = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { department: { select: { name: true } } },
  })
  const finOkSearch = canViewFinance(user.role, deptRow0?.department?.name ?? null, user.role === 'ADMIN' ? 'ADMIN' : null)
  const where = {
    ...(search && {
      OR: [
        { name: { contains: search } },
        { code: { contains: search } },
        ...(finOkSearch ? [{ contractNo: { contains: search } }] : []),
        { customer: { name: { contains: search } } },
      ],
    }),
    ...(statusFilter && { status: statusFilter }),
    ...visibilityWhere,
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
        _count: { select: { phases: true, tasks: true, members: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.project.count({ where }),
  ])

  // 附加 myRole（当前用户在项目内的角色；ADMIN 为 'ADMIN'）
  let roleByProject: Map<string, string> | null = null
  if (user.role !== 'ADMIN' && projects.length > 0) {
    const myMemberships = await prisma.projectMember.findMany({
      where: { userId: user.userId, projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true, role: true },
    })
    roleByProject = new Map(myMemberships.map((m) => [m.projectId, m.role]))
  }
  // 财务脱敏需部门名（AuthUser 不含 department，补查一次）
  const deptRow = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { department: { select: { name: true } } },
  })
  const deptName = deptRow?.department?.name ?? null
  // 文件提交统计（2026-08-21）：每项目「已提交 / 总条目」，供列表绿色进度徽章
  let fileStatsByProject = new Map<string, { submitted: number; total: number }>()
  if (projects.length > 0) {
    const groups = await prisma.fileRequirement.groupBy({
      by: ['projectId', 'status'],
      where: { projectId: { in: projects.map((p) => p.id) } },
      _count: { _all: true },
    })
    const byProject = new Map<string, { submitted: number; total: number }>()
    for (const g of groups) {
      const cur = byProject.get(g.projectId) ?? { submitted: 0, total: 0 }
      cur.total += g._count._all
      if (g.status === 'SUBMITTED' || g.status === 'APPROVED' || g.status === 'REVIEWING') {
        cur.submitted += g._count._all
      }
      byProject.set(g.projectId, cur)
    }
    fileStatsByProject = byProject
  }

  const items = projects.map((p) => {
    const myRole = user.role === 'ADMIN' ? 'ADMIN' : roleByProject?.get(p.id) ?? null
    const finOk = canViewFinance(user.role, deptName, myRole)
    const fs = fileStatsByProject.get(p.id)
    return maskFinance(
      {
        ...p,
        myRole,
        // 文件提交统计（无条目时 total=0）
        fileStats: fs ?? { submitted: 0, total: 0 },
      },
      finOk,
    )
  })

  return okPage(items, page, limit, total)
})

// ───────────────────────────── POST：创建项目（§7.4 契约）─────────────────────────────

const dateStr = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日期格式非法' })

const createProjectSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^DEMO\d{2}\d{3,}$/, '项目编号格式：DEMO+签约年后两位+流水（如 DEMO26001）')
    .optional(),
  name: z.string().trim().min(1, '项目名称不能为空').max(200),
  description: z.string().max(2000).optional(),
  contractNo: z.string().trim().max(100).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  amount: z.union([z.number().nonnegative(), z.string()]).nullable().optional(),
  customerId: z.string().trim().nullable().optional(),
  signedAt: dateStr.nullable().optional(),
  plannedStart: dateStr.nullable().optional(),
  plannedEnd: dateStr.nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  templateId: z.string().trim().optional(),
  stageOverrides: z
    .array(
      z.object({
        order: z.number().int().min(1).max(99),
        ownerId: z.string().trim().nullable().optional(),
        skip: z.boolean().optional(),
      }),
    )
    .optional(),
  members: z
    .array(
      z.object({
        userId: z.string().trim().min(1),
        role: z.enum(['OWNER', 'MANAGER', 'MEMBER', 'VIEWER']).optional(),
        title: z.string().trim().max(50).nullable().optional(),
        // 交付物（2026-08-21）：该成员需提交的工作文件清单
        deliverables: z.array(z.string().trim().max(100)).optional(),
      }),
    )
    .optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  // §7.4：PROJECT_MANAGER；全局 ADMIN 经权限引擎直通（§6.1），故一并列出
  requireRole(user, 'ADMIN', 'PROJECT_MANAGER')

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createProjectSchema.parse(raw)

  // 引擎错误（EngineError 带 status）→ 统一响应壳 ApiError
  try {
    const result = await instantiateProject(user.userId, body)
    return created(
      {
        project: result.project,
        phaseCount: result.phaseCount,
        catalogCount: result.catalogCount,
        requirementCount: result.requirementCount,
        conversationId: result.conversationId,
        memberCount: result.memberCount,
        pendingAssignment: result.pendingAssignment,
      },
      result.pendingAssignment.length > 0
        ? `项目创建成功；${result.pendingAssignment.length} 个阶段未匹配到负责人，请尽快分配`
        : '项目创建成功',
    )
  } catch (e) {
    if (e instanceof EngineError) {
      throw new ApiError(e.status, e.message, e.code)
    }
    throw e
  }
})
