/**
 * /api/projects/[id]/catalogs —— 依据《开发文档-项目管理系统重构》§7.7 + 网盘化改造（20260830-drive-war W2）
 *
 * GET    项目 view   目录树（含每目录条目计数，递归 children；软删过滤；?view=recycle 回收站树）
 * POST   文件夹级    新建目录 { name, parentId?, order?, remark? }（USER 自由目录；SYSTEM 父下仅 MANAGER+）
 * PATCH  文件夹级    维护目录 { id, name?, parentId?, order?, remark? }（USER 目录改名/移动；SYSTEM 目录结构不可变）
 * DELETE 文件夹级    删除目录（USER 目录=软删整树进回收站；SYSTEM 目录 403 受保护）
 *
 * 网盘化语义（spec §3.2）：
 *  - 建目录权限 = 目标父目录 upload（祖先链 ACL 并集，permission.ts FILE_FOLDER 分支）；
 *    根级建目录 = 项目成员 MEMBER 及以上（MANAGER/OWNER/MEMBER，ADMIN 直通；VIEWER 不可）
 *  - MEMBER 的 FILE_FOLDER 基线 = view+upload+edit+download（permission.ts 内扩展）
 *  - 目录删除（整树软删）= 文件夹 delete 权限（MANAGER/OWNER 基线；ACL 可追加）
 *  - SYSTEM 目录（阶段目录/00-交付计划组）：全员禁删/禁改名/禁移动；其下建目录仅 MANAGER+（应急）
 *  - 移动目录维护 path 物化列（子树前缀重写）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, invalidateProject } from '@/lib/permission'
import {
  getLiveFolder,
  assertFolderUsableAsTarget,
  isManagerPlus,
  memberRoleOf,
  childPath,
  rewriteSubtreePaths,
  softDeleteTree,
  retainDaysLeft,
  recycleRetainDays,
} from '@/lib/drive'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// ───────────────────────────── GET：目录树（含条目计数，递归 children）──────────────────────────────

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const view = new URL(request.url).searchParams.get('view')

  // ── 回收站视图：返回已软删目录（含整树结构还原信息）+ 子树内已删文件统计 ──
  if (view === 'recycle') {
    const deleted = await prisma.fileCatalog.findMany({
      where: { projectId: id, deletedAt: { not: null } },
      select: {
        id: true, parentId: true, name: true, kind: true, path: true,
        deletedAt: true, deletedById: true,
        _count: { select: { requirements: true } },
      },
      orderBy: { deletedAt: 'desc' },
    })
    // 子树内已删文件计数（一次聚合）
    const files = await prisma.file.groupBy({
      by: ['folderId'],
      where: { projectId: id, deletedAt: { not: null } },
      _count: { _all: true },
    })
    const fileCountByFolder = new Map(files.map((f) => [f.folderId, f._count._all]))

    // 回收站可见性：MEMBER 仅见自己删的；MANAGER/OWNER/ADMIN 见全部（spec §3.3）
    const managerPlus = await isManagerPlus(user.userId, id)
    const items = managerPlus
      ? deleted
      : deleted.filter((d) => d.deletedById === user.userId)
    // 只展示「树根」级被删目录（子目录被连带删除的不重复展示）
    const deletedIds = new Set(items.map((i) => i.id))
    const roots = items.filter((i) => !i.parentId || !deletedIds.has(i.parentId))

    return ok({
      items: roots.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        name: r.name,
        kind: r.kind,
        path: r.path,
        deletedAt: r.deletedAt,
        deletedById: r.deletedById,
        deletedFileCount: fileCountByFolder.get(r.id) ?? 0,
        requirementCount: r._count.requirements,
        daysLeft: retainDaysLeft(r.deletedAt as Date),
      })),
    })
  }

  // ── 常规视图：软删过滤 ──
  const catalogs = await prisma.fileCatalog.findMany({
    where: { projectId: id, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      parentId: true,
      name: true,
      phaseCode: true,
      order: true,
      remark: true,
      kind: true,
      path: true,
      requirements: {
        select: { id: true, name: true, status: true },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      },
      _count: { select: { requirements: true, children: true } },
    },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  })

  // 建树：先按 parentId 分桶，再从根节点递归组装（软删父目录的存活子目录视为根——防御态）
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
    kind: string
    path: string
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
    kind: node.kind,
    path: node.path,
    requirementCount: node._count.requirements,
    requirements: node.requirements.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
    })),
    children: (byParent.get(node.id) ?? []).map(build),
  })

  const roots = (byParent.get(null) ?? []).map(build)

  // can 语义（网盘化）：建目录/改名=成员 MEMBER+；删除整树=MANAGER+/OWNER（前端按钮近似，服务端终审）
  const memberRole = await memberRoleOf(user.userId, id)
  const canCreate =
    memberRole === 'OWNER' || memberRole === 'MANAGER' || memberRole === 'MEMBER'
  const canDelete = memberRole === 'OWNER' || memberRole === 'MANAGER'
  return ok({
    items: roots,
    can: {
      create: canCreate,
      edit: canCreate,
      delete: canDelete,
    },
  })
})

// ───────────────────────────── 校验工具 ─────────────────────────────

/** 校验目录属于指定项目且存活；parentId 指定时校验同项目、存活且不构成环 */
async function validateParent(
  projectId: string,
  parentId: string | null | undefined,
  selfId?: string,
): Promise<void> {
  if (!parentId) return
  const parent = await prisma.fileCatalog.findUnique({
    where: { id: parentId },
    select: { projectId: true, parentId: true, deletedAt: true },
  })
  if (!parent || parent.deletedAt || parent.projectId !== projectId) {
    throw ApiError.badRequest('父目录不存在、已删除或不属于本项目')
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

/** 根级建目录门槛：项目成员 MEMBER 及以上（VIEWER 排除）或 ADMIN（经 isManagerPlus 失败后再查 MEMBER） */
async function assertCanCreateAt(userId: string, projectId: string, parentId: string | null | undefined): Promise<void> {
  if (!parentId) {
    const role = await memberRoleOf(userId, projectId)
    if (role === 'OWNER' || role === 'MANAGER' || role === 'MEMBER') return
    // 非成员/VIEWER：仍可能被项目级 ACL 授 upload（requireCan 终审）
    await requireCan(userId, 'upload', { type: 'PROJECT', id: projectId })
    return
  }
  const folder = await getLiveFolder(parentId, projectId)
  await requireCan(userId, 'upload', { type: 'FILE_FOLDER', id: parentId })
  await assertFolderUsableAsTarget(userId, folder)
}

// ───────────────────────────── POST：新建目录（USER 自由目录）──────────────────────────────

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  const body = catalogSchema.parse(await request.json())
  await validateParent(id, body.parentId)
  await assertCanCreateAt(user.userId, id, body.parentId)

  // 归档项目禁写（与 upload/move 口径一致）
  const project = await prisma.project.findUnique({ where: { id }, select: { isArchived: true } })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw ApiError.forbidden('项目已归档，禁止新建目录')

  // 同级重名校验（大小写不敏感，spec §3.1）
  const dup = await prisma.fileCatalog.findFirst({
    where: {
      projectId: id,
      parentId: body.parentId ?? null,
      deletedAt: null,
      name: { equals: body.name, mode: 'insensitive' },
    },
    select: { id: true },
  })
  if (dup) throw ApiError.badRequest(`同级已存在同名目录「${body.name}」`)

  const parentPath = body.parentId
    ? (await prisma.fileCatalog.findUnique({ where: { id: body.parentId }, select: { path: true } }))?.path ?? null
    : null

  const catalog = await prisma.$transaction(async (tx) => {
    const row = await tx.fileCatalog.create({
      data: {
        projectId: id,
        name: body.name,
        parentId: body.parentId ?? null,
        phaseCode: null, // 用户目录不关联阶段（阶段目录由流程引擎生成）
        order: body.order ?? 0,
        remark: body.remark ?? null,
        kind: 'USER',
        path: '', // 先占位，建行后回填（需自增 id）
      },
    })
    const path = childPath(parentPath, row.id)
    const final = await tx.fileCatalog.update({ where: { id: row.id }, data: { path } })
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.create',
        detail: { catalogId: row.id, name: body.name, parentId: body.parentId ?? null, kind: 'USER' } as Prisma.InputJsonValue,
      },
    })
    return final
  })

  invalidateProject(id)
  return created(catalog, '目录已创建')
})

// ───────────────────────────── PATCH：维护目录（USER 改名/移动；SYSTEM 结构不可变）──────────────────────────────

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

  const body = patchSchema.parse(await request.json())
  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: body.id },
    select: { id: true, projectId: true, name: true, kind: true, path: true, deletedAt: true },
  })
  if (!catalog || catalog.deletedAt) throw ApiError.notFound('目录不存在或已在回收站')
  if (catalog.projectId !== id) throw ApiError.badRequest('目录不属于本项目')

  const structural = body.name !== undefined || body.parentId !== undefined || body.phaseCode !== undefined
  if (catalog.kind === 'SYSTEM' && structural) {
    throw ApiError.forbidden('系统目录（交付计划结构）不可改名/移动/改阶段，受保护')
  }

  // 归档项目禁写
  const project = await prisma.project.findUnique({ where: { id }, select: { isArchived: true } })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived && (structural || body.order !== undefined)) {
    throw ApiError.forbidden('项目已归档，禁止调整目录')
  }

  // 权限：文件夹级 edit（含改名/移动；order/remark 维护同门槛，简化一致）
  await requireCan(user.userId, 'edit', { type: 'FILE_FOLDER', id: body.id })

  const moving = body.parentId !== undefined && body.parentId !== (await currentParent(body.id))
  if (body.parentId !== undefined) {
    await validateParent(id, body.parentId, body.id)
    if (body.parentId) {
      const target = await getLiveFolder(body.parentId, id)
      // 目标侧权限：父目录 upload + SYSTEM 应急门槛
      await requireCan(user.userId, 'upload', { type: 'FILE_FOLDER', id: body.parentId })
      await assertFolderUsableAsTarget(user.userId, target)
    } else {
      // 移到根级：根级建目录门槛
      const role = await memberRoleOf(user.userId, id)
      if (!(role === 'OWNER' || role === 'MANAGER' || role === 'MEMBER')) {
        await requireCan(user.userId, 'upload', { type: 'PROJECT', id })
      }
    }
  }

  // 改名重名校验
  if (body.name !== undefined && body.name !== catalog.name) {
    const dup = await prisma.fileCatalog.findFirst({
      where: {
        projectId: id,
        parentId: body.parentId !== undefined ? (body.parentId ?? null) : (await currentParent(body.id)) ?? null,
        deletedAt: null,
        id: { not: body.id },
        name: { equals: body.name, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (dup) throw ApiError.badRequest(`同级已存在同名目录「${body.name}」`)
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
    // 移动 → 重写子树 path
    if (moving) {
      const newParentPath = body.parentId
        ? (await tx.fileCatalog.findUnique({ where: { id: body.parentId! }, select: { path: true } }))?.path ?? null
        : null
      const newPath = childPath(newParentPath, row.id)
      await rewriteSubtreePaths(tx as never, row.id, catalog.path, newPath)
    }
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.update',
        detail: { catalogId: row.id, name: row.name, moved: moving } as Prisma.InputJsonValue,
      },
    })
    return row
  })

  invalidateProject(id)
  return ok(updated, '目录已更新')
})

async function currentParent(catalogId: string): Promise<string | null> {
  const c = await prisma.fileCatalog.findUnique({ where: { id: catalogId }, select: { parentId: true } })
  return c?.parentId ?? null
}

// ───────────────────────────── DELETE：删除目录（USER=软删整树进回收站；SYSTEM=403）──────────────────────────────

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

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
    select: { id: true, projectId: true, name: true, kind: true, path: true, deletedAt: true },
  })
  if (!catalog || catalog.deletedAt) throw ApiError.notFound('目录不存在或已在回收站')
  if (catalog.projectId !== id) throw ApiError.badRequest('目录不属于本项目')

  // SYSTEM 目录受保护（全员，含 ADMIN——流程引擎结构，spec §3.1）
  if (catalog.kind === 'SYSTEM') {
    throw ApiError.forbidden(`系统目录「${catalog.name}」受交付计划保护，不可删除`)
  }

  // 权限：文件夹级 delete（MANAGER/OWNER 基线；ACL 可追加）
  await requireCan(user.userId, 'delete', { type: 'FILE_FOLDER', id: catalogId })

  // 归档项目禁删
  const project = await prisma.project.findUnique({ where: { id }, select: { isArchived: true } })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw ApiError.forbidden('项目已归档，禁止删除目录')

  const result = await prisma.$transaction(async (tx) => {
    const r = await softDeleteTree(catalog, user.userId, tx as never)
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'file-catalog.delete',
        detail: { catalogId: catalog.id, name: catalog.name, soft: true, ...r } as Prisma.InputJsonValue,
      },
    })
    return r
  })

  invalidateProject(id)
  return ok(
    { id: catalogId, ...result },
    `目录「${catalog.name}」已移入回收站（${result.folders} 个目录 / ${result.files} 个文件，${recycleRetainDays()} 天内可恢复）`,
  )
})
