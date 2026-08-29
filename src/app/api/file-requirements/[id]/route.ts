/**
 * /api/file-requirements/:id —— 单条目详情（2026-08-21 补 GET，跳转打开抽屉用）
 *
 * GET    登录  单条目详情（含项目/目录/文件列表）
 * DELETE 删除工程第 4 棒（文件域，§2/§2.4/§2.5）：物理删除仅 WAITING 未提交条目
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, invalidateProject } from '@/lib/permission'
import { logDelete } from '@/lib/delete-helpers'
import { resolveStoredFile } from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler(async (_request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(_request)
  const item = await prisma.fileRequirement.findUnique({
    where: { id: id },
    include: {
      project: { select: { id: true, code: true, name: true } },
      catalog: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      reviewer: { select: { id: true, name: true } },
      files: {
        select: {
          id: true,
          name: true,
          originalName: true,
          version: true,
          size: true,
          mimeType: true,
          uploadedById: true,
          uploadedBy: { select: { id: true, name: true } },
          createdAt: true,
        },
        orderBy: { version: 'desc' },
      },
    },
  })
  if (!item) throw ApiError.notFound('条目不存在')

  await requireCan(user.userId, 'view', { type: 'FILE_REQ', id: id })

  // 按钮级权限（上传/下载/审核）
  const perms = await permsOf(user.userId, { type: 'FILE_REQ', id: id })

  return ok({
    id: item.id,
    name: item.name,
    code: item.code,
    required: item.required,
    ownerId: item.ownerId,
    owner: item.owner,
    externalOrgId: item.externalOrgId,
    purpose: item.purpose,
    scope: item.scope,
    scopeRefs: item.scopeRefs,
    dueDate: item.dueDate,
    status: item.status,
    reviewerId: item.reviewerId,
    reviewer: item.reviewer,
    phaseCode: item.phaseCode,
    catalogId: item.catalogId,
    catalog: item.catalog,
    remark: item.remark,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    project: item.project,
    files: item.files,
    permissions: perms,
  })
})

// ───────────── DELETE：物理删除文件条目（删除工程第 4 棒，§2.3 状态闸/§2.4 级联/§2.5 审计）─────────────

/** 非 WAITING 状态的 400 提示文案（已提交走 obsolete / reject 流程，保留审计链） */
const STATUS_TEXT: Record<string, string> = {
  SUBMITTED: '已提交',
  REVIEWING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  NA: '已标记不适用',
  OBSOLETED: '已作废',
}

export const DELETE = apiHandler(async (_request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(_request)

  // 权限：条目责任人（ownerId）/ 审核人（reviewerId）/ ADMIN（DB 实时角色，防 JWT 降级窗口，同第 2 棒口径）
  const [dbUser, item] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.userId },
      select: { role: true, isActive: true },
    }),
    prisma.fileRequirement.findUnique({
      where: { id: id },
      select: {
        id: true,
        projectId: true,
        catalogId: true,
        name: true,
        code: true,
        status: true,
        ownerId: true,
        reviewerId: true,
        project: { select: { isArchived: true } },
        files: { select: { id: true, storagePath: true } },
      },
    }),
  ])
  if (!item) throw ApiError.notFound('文件条目不存在')

  const isAdmin = !!dbUser && dbUser.isActive && dbUser.role === 'ADMIN'
  const isOwner = item.ownerId === user.userId
  const isReviewer = item.reviewerId === user.userId
  if (!isAdmin && !isOwner && !isReviewer) {
    throw ApiError.forbidden('仅条目责任人、审核人或系统管理员可删除文件条目')
  }

  // 归档冻结（只读态，同第 2 棒：不分角色一律拒绝，需先解除归档）
  if (item.project.isArchived) {
    throw ApiError.badRequest('项目已归档，禁止删除文件条目；如需调整请先解除归档')
  }

  // 状态闸（§2.3）：仅 WAITING（未提交）可物理删；已进入流程走 obsolete/reject 保留审计链
  if (item.status !== 'WAITING') {
    const label = STATUS_TEXT[item.status] ?? item.status
    throw ApiError.badRequest(
      `该条目${label}，不可物理删除；已提交的文件请改用「作废」或「驳回」处理以保留审核记录`,
    )
  }

  const projectId = item.projectId
  const catalogId = item.catalogId

  const deleted = await prisma.$transaction(async (tx) => {
    // 1) 关联文件先删（WAITING 理论上无文件，防御性兜底；磁盘清理在事务外容错执行）
    const files = await tx.file.deleteMany({ where: { requirementId: id } })

    // 2) 无 FK 关联的痕迹记录：催办 / 待办 / 通知（link 精确匹配，cuid 定长不误伤）
    const urgeRecords = await tx.urgeRecord.deleteMany({ where: { requirementId: id } })
    const todoItems = await tx.todoItem.deleteMany({
      where: { sourceType: 'FILE_REQ', sourceId: id },
    })
    const notifications = await tx.notification.deleteMany({
      where: { link: `/files?projectId=${projectId}&requirementId=${id}` },
    })

    // 3) 条目上的 ACL 授予（ResourcePermission 无 FK，显式清理防空挂）
    const resourcePermissions = await tx.resourcePermission.deleteMany({
      where: { resourceType: 'FILE_REQ', resourceId: id },
    })

    // 4) 物理删除条目行
    await tx.fileRequirement.delete({ where: { id: id } })

    // 5) 空目录回收（工程决策）：条目删除后若所在目录变空（无子目录、无其他条目、
    //    无计划外文件）则连带删除该目录节点，避免残留空壳；不递归向上（父目录
    //    可能承载其他阶段结构，交由既有目录删除 API 管控）。磁盘目录清理事务外容错。
    const [childCount, reqCount, looseFileCount] = await Promise.all([
      tx.fileCatalog.count({ where: { parentId: catalogId } }),
      tx.fileRequirement.count({ where: { catalogId } }),
      tx.file.count({
        where: { projectId, storagePath: { startsWith: `${projectId}/${catalogId}/` } },
      }),
    ])
    let catalogs = 0
    if (childCount === 0 && reqCount === 0 && looseFileCount === 0) {
      const cat = await tx.fileCatalog.delete({ where: { id: catalogId } }).catch(() => null)
      catalogs = cat ? 1 : 0
    }

    return {
      files: files.count,
      urgeRecords: urgeRecords.count,
      todoItems: todoItems.count,
      notifications: notifications.count,
      resourcePermissions: resourcePermissions.count,
      catalogs,
    }
  })

  invalidateProject(projectId)

  // 磁盘清理（事务外容错：失败仅告警不报错，不留孤儿文件尽力而为）
  const { unlink, rm } = await import('fs/promises')
  let storageCleaned = 0
  for (const f of item.files) {
    const abs = resolveStoredFile(f.storagePath)
    if (!abs) {
      console.warn(`[file-requirement.delete] 存储路径非法，跳过磁盘清理：${f.storagePath}`)
      continue
    }
    try {
      await unlink(abs)
      storageCleaned += 1
    } catch (e) {
      console.warn(`[file-requirement.delete] 磁盘文件删除失败（忽略）：${abs}`, e)
    }
  }
  if (deleted.catalogs > 0) {
    const catDir = resolveStoredFile(`${projectId}/${catalogId}`)
    if (catDir) {
      await rm(catDir, { recursive: true, force: true }).catch((e: unknown) => {
        console.warn(`[file-requirement.delete] 磁盘目录删除失败（忽略）：${catDir}`, e)
      })
    }
  }

  // 审计留痕（§2.5）
  await logDelete(user.userId, 'fileRequirement', id, {
    name: item.name,
    code: item.code,
    status: item.status,
    ...deleted,
    storageCleaned,
  }, projectId)

  return ok(
    { id: id, deleted: { ...deleted, storageCleaned } },
    `文件条目「${item.name}」已删除`,
  )
})
