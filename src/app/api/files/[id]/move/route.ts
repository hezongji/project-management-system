/**
 * PATCH /api/files/:id/move —— 网盘化改造（20260830-drive-war W2）
 *
 * 仅允许**计划外文件**（requirementId=null）在**项目内**移动目录：
 *  - 条目文件（挂交付计划条目）禁止移动：移动会与 requirement.catalogId 矛盾、
 *     绕过条目审核语义 → 400
 *  - 跨项目移动禁止 → 400
 *
 * 网盘化语义变更（spec §3.4/§3.9）：**移动只改 File.folderId（DB-only），storagePath 物理路径
 * 不再变更**——物理/逻辑彻底解耦，永不搬文件（历史版本的物理 rename 逻辑废弃）。
 * 兼容：旧客户端传 catalogId（IM App）→ 等同 folderId。
 *
 * 权限：源目录 edit + 目标目录 upload（文件夹级，MEMBER 基线含两者）；
 * SYSTEM 目标仅 MANAGER+（应急）。审计 FileAccessLog(MOVE)。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidateProject } from '@/lib/permission'
import { getLiveFolder, assertFolderUsableAsTarget } from '@/lib/drive'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const PATCH = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  const body = (await request.json().catch(() => ({}))) as { catalogId?: string; folderId?: string }
  // 兼容旧入参 catalogId（IM App 存量客户端）
  const targetFolderId = String(body.folderId ?? body.catalogId ?? '').trim()
  if (!targetFolderId) throw ApiError.badRequest('缺少 folderId（移动目标目录）')

  const file = await prisma.file.findUnique({
    where: { id },
    select: {
      id: true,
      requirementId: true,
      projectId: true,
      name: true,
      originalName: true,
      folderId: true,
      deletedAt: true,
      project: { select: { isArchived: true } },
    },
  })
  if (!file || file.deletedAt) throw ApiError.notFound('文件不存在或已在回收站')

  // 归档冻结（对齐 delete/upload 口径）
  if (file.project.isArchived) {
    throw ApiError.badRequest('项目已归档，禁止移动文件；如需调整请先解除归档')
  }

  // 条目文件禁止移动（交付计划管理）
  if (file.requirementId) {
    throw ApiError.badRequest('条目文件不可移动（受交付计划管理）')
  }

  // 目标目录必须存在、存活且属于同一项目（跨项目禁止）
  const target = await getLiveFolder(targetFolderId)
  if (target.projectId !== file.projectId) {
    throw ApiError.badRequest('仅支持项目内移动')
  }
  if (target.id === file.folderId) {
    return ok({ file: { id: file.id, folderId: file.folderId } }, '文件已在该目录（无需移动）')
  }

  // 权限：源目录 edit（源在回收站/无 folder 的孤儿文件→项目级 edit）+ 目标目录 upload
  if (file.folderId) {
    const src = await prisma.fileCatalog.findUnique({
      where: { id: file.folderId },
      select: { deletedAt: true },
    })
    if (src && !src.deletedAt) {
      await requireCan(user.userId, 'edit', { type: 'FILE_FOLDER', id: file.folderId })
    }
  } else {
    await requireCan(user.userId, 'edit', { type: 'PROJECT', id: file.projectId })
  }
  await requireCan(user.userId, 'upload', { type: 'FILE_FOLDER', id: target.id })
  await assertFolderUsableAsTarget(user.userId, target)

  // ★ DB-only 移动：只改 folderId，storagePath 物理路径不动（spec §3.9 零搬迁）
  // 版本家族整组移动（同 folderId+originalName 的自由文件是一家，移动不能拆家；
  // 条目文件已在上方拦截，此处均为自由文件）
  const updated = await prisma.$transaction(async (tx) => {
    const fam = file.originalName
      ? await tx.file.findMany({
          where: {
            folderId: file.folderId,
            originalName: file.originalName,
            requirementId: null,
            deletedAt: null,
          },
          select: { id: true },
        })
      : [{ id }]
    const familyIds = fam.map((f) => f.id)
    await tx.file.updateMany({
      where: { id: { in: familyIds } },
      data: { folderId: target.id },
    })
    await tx.fileAccessLog.create({
      data: { fileId: id, userId: user.userId, action: 'MOVE' },
    })
    return tx.file.findUnique({ where: { id } })
  })

  invalidateProject(file.projectId)
  return ok(
    {
      file: {
        id: updated?.id,
        name: updated?.name,
        originalName: updated?.originalName,
        size: updated?.size,
        mimeType: updated?.mimeType,
        storagePath: updated?.storagePath, // 物理路径不变（解耦证明）
        folderId: updated?.folderId,
        projectId: updated?.projectId,
      },
    },
    '文件已移动',
  )
})
