/**
 * /api/file-requirements —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * GET   条目 view（范围过滤）  ?projectId=&catalogId=&status=&mine=1&overdue=1&page=&limit=
 * POST  项目 edit  手动建条目 { projectId, catalogId, name, code?, ownerId?, externalOrgId?,
 *                              purpose?, scope?, scopeRefs?, dueDate?, required?, reviewerId?,
 *                              phaseCode?, remark? }
 *
 * 说明：
 *  - GET 走 visibleRequirementFilter（§6.1 范围终审：PUBLIC/RESTRICTED/PRIVATE 三档），
 *    与 can() 语义一致，未登录/非成员/范围外一律不可见。
 *  - 每条目附 files 版本数组摘要 + permissions（8 键，permsOf 按钮级权限）。
 *  - 列表级返回 can.create（= 项目 edit 权限，控制「新建/导入」按钮显隐）。
 *  - POST 校验目录属于该项目、责任人/审核人/外部主体存在；记 ActivityLog + 失效缓存。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma, FileScope } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, batchPermsOf, visibleRequirementFilter } from '@/lib/permission'

export const dynamic = 'force-dynamic'

const VALID_STATUS = ['WAITING', 'SUBMITTED', 'REVIEWING', 'APPROVED', 'REJECTED', 'NA', 'OBSOLETED'] as const
type StatusFilter = (typeof VALID_STATUS)[number]

// ───────────────────────────── GET：条目列表（范围过滤 + 分页）──────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const { searchParams } = new URL(request.url)
  const projectId = (searchParams.get('projectId') || '').trim()
  if (!projectId) throw ApiError.badRequest('缺少 projectId 参数')

  const catalogId = (searchParams.get('catalogId') || '').trim() || undefined
  const rawStatus = searchParams.get('status') || undefined
  const status: StatusFilter | undefined =
    rawStatus && (VALID_STATUS as readonly string[]).includes(rawStatus)
      ? (rawStatus as StatusFilter)
      : rawStatus
        ? (() => {
            throw ApiError.badRequest(`无效的状态筛选：${rawStatus}`)
          })()
        : undefined
  const mine = searchParams.get('mine') === '1'
  const overdue = searchParams.get('overdue') === '1'

  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20))
  const skip = (page - 1) * limit

  // 范围终审过滤（§6.1 第 4 步）∧ 项目 ∧ 目录 ∧ 状态 ∧ 我负责 ∧ 超期
  const scopeFilter = await visibleRequirementFilter(user.userId)
  const now = new Date()
  const where: Prisma.FileRequirementWhereInput = {
    ...scopeFilter,
    projectId,
    ...(catalogId ? { catalogId } : {}),
    ...(status ? { status } : {}),
    ...(mine ? { ownerId: user.userId } : {}),
    ...(overdue
      ? {
          dueDate: { lt: now },
          status: { in: ['WAITING', 'SUBMITTED', 'REVIEWING', 'REJECTED'] },
        }
      : {}),
  }

  const [items, total, projectPerms] = await Promise.all([
    prisma.fileRequirement.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        catalog: { select: { id: true, name: true } },
        files: {
          include: { uploadedBy: { select: { id: true, name: true } } },
          orderBy: { version: 'desc' },
        },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { name: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.fileRequirement.count({ where }),
    permsOf(user.userId, { type: 'PROJECT', id: projectId }),
  ])

  // externalOrgId 无关系字段（§5 模型），单独批量解析外部主体名称
  const externalOrgIds = Array.from(
    new Set(items.map((r) => r.externalOrgId).filter((x): x is string => !!x)),
  )
  const externalOrgs = externalOrgIds.length > 0
    ? await prisma.externalOrg.findMany({
        where: { id: { in: externalOrgIds } },
        select: { id: true, name: true },
      })
    : []
  const externalOrgMap = new Map(externalOrgs.map((o) => [o.id, o]))

  // 批量权限（2026-08-22 P1-4 修复）：N 次 permsOf → 1 次 batchPermsOf
  const permMap = await batchPermsOf(
    user.userId,
    items.map((r) => ({
      type: 'FILE_REQ' as const,
      id: r.id,
      projectId: r.projectId,
      ownerId: r.ownerId,
      scope: r.scope,
      scopeRefs: r.scopeRefs ?? undefined,
      phaseCode: r.phaseCode,
    })),
  )

  // 每条目附加按钮级 permissions（§7.7 条目对象 + §4.7）
  const dto = items.map((r) => {
    const perms = permMap.get(r.id) ?? { view: false, edit: false, upload: false, approve: false, download: false, assign: false, archive: false }
    return {
        id: r.id,
        name: r.name,
        code: r.code,
        required: r.required,
        ownerId: r.ownerId,
        owner: r.owner,
        externalOrgId: r.externalOrgId,
        externalOrg: r.externalOrgId
          ? (externalOrgMap.get(r.externalOrgId) ?? null)
          : null,
        purpose: r.purpose,
        scope: r.scope,
        scopeRefs: r.scopeRefs,
        dueDate: r.dueDate,
        status: r.status,
        reviewerId: r.reviewerId,
        reviewer: r.reviewer,
        phaseCode: r.phaseCode,
        catalogId: r.catalogId,
        catalog: r.catalog,
        remark: r.remark,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        files: r.files.map((f) => ({
          id: f.id,
          version: f.version,
          name: f.name,
          originalName: f.originalName,
          size: f.size,
          mimeType: f.mimeType,
          uploadedById: f.uploadedById,
          uploadedBy: f.uploadedBy,
          createdAt: f.createdAt,
        })),
        permissions: perms,
      }
    })

  return ok({
    items: dto,
    pagination: { page, limit, total, pages: limit > 0 ? Math.ceil(total / limit) : 0 },
    can: { create: projectPerms.edit },
  })
})

// ───────────────────────────── POST：手动建条目 ─────────────────────────────

const dateStr = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日期格式非法' })

const scopeRefsSchema = z
  .object({
    userIds: z.array(z.string()).optional(),
    deptIds: z.array(z.string()).optional(),
  })
  .nullable()
  .optional()

const createSchema = z.object({
  projectId: z.string().trim().min(1, 'projectId 不能为空'),
  catalogId: z.string().trim().min(1, 'catalogId 不能为空'),
  name: z.string().trim().min(1, '文件名称不能为空').max(200),
  code: z.string().trim().max(100).nullable().optional(),
  phaseCode: z.string().trim().max(20).nullable().optional(),
  ownerId: z.string().trim().min(1).nullable().optional(),
  externalOrgId: z.string().trim().min(1).nullable().optional(),
  purpose: z.string().trim().max(200).nullable().optional(),
  scope: z.nativeEnum(FileScope).optional(),
  scopeRefs: scopeRefsSchema,
  dueDate: dateStr.nullable().optional(),
  required: z.boolean().optional(),
  reviewerId: z.string().trim().min(1).nullable().optional(),
  remark: z.string().trim().max(500).nullable().optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const body = createSchema.parse(await request.json())

  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: body.projectId })

  // 目录必须属于该项目
  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: body.catalogId },
    select: { id: true, projectId: true },
  })
  if (!catalog || catalog.projectId !== body.projectId) {
    throw ApiError.badRequest('目录不存在或不属于该项目')
  }

  // 责任人 / 审核人 / 外部主体存在性
  if (body.ownerId) {
    const u = await prisma.user.findUnique({ where: { id: body.ownerId }, select: { id: true } })
    if (!u) throw ApiError.badRequest('责任人不存在')
  }
  if (body.reviewerId) {
    const u = await prisma.user.findUnique({ where: { id: body.reviewerId }, select: { id: true } })
    if (!u) throw ApiError.badRequest('审核人不存在')
  }
  if (body.externalOrgId) {
    const o = await prisma.externalOrg.findUnique({ where: { id: body.externalOrgId }, select: { id: true } })
    if (!o) throw ApiError.badRequest('外部提供方不存在')
  }

  const requirement = await prisma.$transaction(async (tx) => {
    const row = await tx.fileRequirement.create({
      data: {
        projectId: body.projectId,
        catalogId: body.catalogId,
        name: body.name,
        code: body.code ?? null,
        phaseCode: body.phaseCode ?? null,
        ownerId: body.ownerId ?? null,
        externalOrgId: body.externalOrgId ?? null,
        purpose: body.purpose ?? null,
        scope: body.scope ?? 'PUBLIC',
        scopeRefs: body.scopeRefs ? (body.scopeRefs as Prisma.InputJsonValue) : Prisma.JsonNull,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        required: body.required ?? true,
        reviewerId: body.reviewerId ?? null,
        remark: body.remark ?? null,
        status: 'WAITING',
      },
    })
    await tx.activityLog.create({
      data: {
        projectId: body.projectId,
        userId: user.userId,
        action: 'file-requirement.create',
        detail: { requirementId: row.id, name: row.name, catalogId: row.catalogId } as Prisma.InputJsonValue,
      },
    })
    return row
  })

  const perms = await permsOf(user.userId, { type: 'FILE_REQ', id: requirement.id })
  return created(
    {
      ...requirement,
      scopeRefs: requirement.scopeRefs,
      permissions: perms,
    },
    '文件条目已创建',
  )
})
