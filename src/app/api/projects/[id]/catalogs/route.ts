/**
 * /api/projects/[id]/catalogs —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * GET    项目 view   目录树（含每目录条目计数，递归 children）
 * POST   项目 edit   新建目录 { name, parentId?, phaseCode?, order?, remark? }
 * PATCH  项目 edit   维护目录 { id, name?, parentId?, phaseCode?, order?, remark? }
 * DELETE 项目 edit   删除目录（需空目录：无子目录且无条目，否则 400）
 *
 * 说明：
 *  - 目录 id 通过请求体传递（契约 POST/PATCH/DELETE 共用 /projects/:id/catalogs，
 *    无 /catalogs/:catalogId 子路由）；DELETE 亦兼容 ?catalogId= 查询参数。
 *  - 移动目录（改 parentId）时校验目标父目录同属本项目、且不构成环。
 *  - 写操作记 ActivityLog 并失效项目权限缓存（目录/条目范围依赖项目成员基线）。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, invalidateProject } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// ───────────────────────────── GET：目录树（含条目计数，递归 children）──────────────────────────────

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const catalogs = await prisma.fileCatalog.findMany({
    where: { projectId: id },
    select: {
      id: true,
      projectId: true,
      parentId: true,
      name: true,
      phaseCode: true,
      order: true,
      remark: true,
      requirements: {
        select: { id: true, name: true, status: true },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      },
      _count: { select: { requirements: true, children: true } },
    },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  })

  // 建树：先按 parentId 分桶，再从根节点递归组装
  const byParent = new Map<string | null, typeof catalogs>()
  for (const c of catalogs) {
    const list = byParent.get(c.parentId) ?? []
    list.push(c)
    byParent.set(c.parentId, list)
  }

  type TreeNode = {
    id: string
    projectId: string
    parentId: string | null
    name: string
    phaseCode: string | null
    order: number
    remark: string | null
    requirementCount: number
    requirements: { id: string; name: string; status: string }[]
    children: TreeNode[]
  }

  const build = (node: (typeof catalogs)[number]): TreeNode => ({
    id: node.id,
    projectId: node.projectId,
    parentId: node.parentId,
    name: node.name,
    phaseCode: node.phaseCode,
    order: node.order,
    remark: node.remark,
    requirementCount: node._count.requirements,
    requirements: node.requirements.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
    })),
    children: (byParent.get(node.id) ?? []).map(build),
  })

  const roots = (byParent.get(null) ?? []).map(build)

  const perms = await permsOf(user.userId, { type: 'PROJECT', id: id })
  return ok({
    items: roots,
    can: { create: perms.edit, edit: perms.edit, delete: perms.edit },
  })
})

// ───────────────────────────── 校验工具 ─────────────────────────────

/** 校验目录属于指定项目；parentId 指定时校验同项目且不构成环 */
async function validateParent(
  projectId: string,
  parentId: string | null | undefined,
  selfId?: string,
): Promise<void> {
  if (!parentId) return
  const parent = await prisma.fileCatalog.findUnique({
    where: { id: parentId },
    select: { projectId: true, parentId: true },
  })
  if (!parent || parent.projectId !== projectId) {
    throw ApiError.badRequest('父目录不存在或不属于本项目')
  }
  // 环检测：沿 parent 链上溯，不得回到 selfId
  if (selfId) {
    let cursor: { parentId: string | null } | null = parent
    const seen = new Set<string>()
    while (cursor) {
      if (cursor.parentId === selfId) {
        throw ApiError.badRequest('不能将目录移动到自身或其子目录下')
      }
      if (!cursor.parentId) break
      if (seen.has(cursor.parentId)) break
      seen.add(cursor.parentId)
      cursor = await prisma.fileCatalog.findUnique({
        where: { id: cursor.parentId },
        select: { parentId: true },
      })
    }
  }
}

const catalogSchema = z.object({
  name: z.string().trim().min(1, '目录名不能为空').max(120),
  parentId: z.string().trim().min(1).nullable().optional(),
  phaseCode: z.string().trim().max(20).nullable().optional(),
  order: z.number().int().min(0).optional(),
  remark: z.string().trim().max(500).nullable().optional(),
})

// ───────────────────────────── POST：新建目录 ─────────────────────────────

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const body = catalogSchema.parse(await request.json())
  await validateParent(id, body.parentId)

  const catalog = await prisma.$transaction(async (tx) => {
    const row = await tx.fileCatalog.create({
      data: {
        projectId: id,
        name: body.name,
        parentId: body.parentId ?? null,
        phaseCode: body.phaseCode ?? null,
        order: body.order ?? 0,
        remark: body.remark ?? null,
      },
    })
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.create',
        detail: { catalogId: row.id, name: body.name, parentId: body.parentId ?? null } as Prisma.InputJsonValue,
      },
    })
    return row
  })

  invalidateProject(id)
  return created(catalog, '目录已创建')
})

// ───────────────────────────── PATCH：维护目录 ─────────────────────────────

const patchSchema = z.object({
  id: z.string().trim().min(1, '目录 id 不能为空'),
  name: z.string().trim().min(1, '目录名不能为空').max(120).optional(),
  parentId: z.string().trim().min(1).nullable().optional(),
  phaseCode: z.string().trim().max(20).nullable().optional(),
  order: z.number().int().min(0).optional(),
  remark: z.string().trim().max(500).nullable().optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const body = patchSchema.parse(await request.json())
  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: body.id },
    select: { id: true, projectId: true },
  })
  if (!catalog || catalog.projectId !== id) {
    throw ApiError.notFound('目录不存在或不属于本项目')
  }
  if (body.parentId !== undefined) {
    await validateParent(id, body.parentId, body.id)
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.fileCatalog.update({
      where: { id: body.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.phaseCode !== undefined ? { phaseCode: body.phaseCode } : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
        ...(body.remark !== undefined ? { remark: body.remark } : {}),
      },
    })
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.update',
        detail: { catalogId: row.id, name: row.name } as Prisma.InputJsonValue,
      },
    })
    return row
  })

  invalidateProject(id)
  return ok(updated, '目录已更新')
})

// ───────────────────────────── DELETE：删除目录（需空目录）────────────────────────────

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  // id 优先取请求体，兼容 ?catalogId= 查询参数（DELETE 带 body 的部分客户端不支持）
  let catalogId: string | null = null
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      const body = (await request.json()) as { id?: string }
      catalogId = body.id ?? null
    } catch {
      catalogId = null
    }
  }
  if (!catalogId) {
    catalogId = new URL(request.url).searchParams.get('catalogId')
  }
  if (!catalogId) throw ApiError.badRequest('缺少目录 id（请求体 {id} 或 ?catalogId=）')

  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: catalogId },
    select: {
      id: true,
      projectId: true,
      name: true,
      _count: { select: { requirements: true, children: true } },
    },
  })
  if (!catalog || catalog.projectId !== id) {
    throw ApiError.notFound('目录不存在或不属于本项目')
  }
  if (catalog._count.children > 0) {
    throw ApiError.badRequest(`目录「${catalog.name}」下还有子目录，请先清空或移动子目录`)
  }
  if (catalog._count.requirements > 0) {
    throw ApiError.badRequest(`目录「${catalog.name}」下还有 ${catalog._count.requirements} 个文件条目，不能删除`)
  }

  await prisma.$transaction(async (tx) => {
    await tx.fileCatalog.delete({ where: { id: catalogId! } })
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.delete',
        detail: { catalogId: catalogId!, name: catalog.name } as Prisma.InputJsonValue,
      },
    })
  })

  invalidateProject(id)
  return ok({ id: catalogId }, `目录「${catalog.name}」已删除`)
})
