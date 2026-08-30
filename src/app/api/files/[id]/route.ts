/**
 * DELETE /api/files/:id —— 删除工程第 4 棒（文件域，§2/§2.5）+ 网盘化 PATCH 重命名（20260830-drive-war W2）
 *
 * PATCH  重命名（仅自由文件 requirementId=null；DB-only，storagePath 不变；审计 RENAME）
 * DELETE 物理删除（历史行为保留：上传人/条目审核人/ADMIN；网盘推荐走 batch 软删进回收站）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { logDelete } from '@/lib/delete-helpers'
import { resolveStoredFile } from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// ───────────────────── PATCH：重命名（网盘化，仅自由文件） ─────────────────────

export const PATCH = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  const body = (await request.json().catch(() => ({}))) as { name?: string }
  const name = String(body.name ?? '').trim()
  if (!name || name.length > 200) throw ApiError.badRequest('文件名不能为空且不超过 200 字符')

  const file = await prisma.file.findUnique({
    where: { id },
    select: {
      id: true,
      requirementId: true,
      projectId: true,
      folderId: true,
      name: true,
      originalName: true,
      deletedAt: true,
      project: { select: { isArchived: true } },
    },
  })
  if (!file || file.deletedAt) throw ApiError.notFound('文件不存在或已在回收站')
  if (file.project.isArchived) throw ApiError.badRequest('项目已归档，禁止重命名')
  if (file.requirementId) {
    throw ApiError.badRequest('条目文件名称由交付计划管理，不可自由重命名')
  }

  // 权限：所在目录 edit（孤儿文件→项目级 edit）
  if (file.folderId) {
    await requireCan(user.userId, 'edit', { type: 'FILE_FOLDER', id: file.folderId })
  } else {
    await requireCan(user.userId, 'edit', { type: 'PROJECT', id: file.projectId })
  }

  // 同目录同名冲突（重命名不产生副本合并语义：撞名→提示）
  if (name !== file.originalName) {
    const dup = await prisma.file.findFirst({
      where: {
        folderId: file.folderId,
        originalName: name,
        requirementId: null,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (dup) throw ApiError.badRequest(`目录下已存在同名文件「${name}」（同名上传会自动合并版本，改名不会）`)
  }

  const updated = await prisma.$transaction(async (tx) => {
    // 同步整组版本行（同 folderId+originalName 的自由文件是一家版本，改名不能拆家）
    const rows = await tx.file.updateMany({
      where: {
        folderId: file.folderId,
        originalName: file.originalName,
        requirementId: null,
        deletedAt: null,
      },
      data: { name, originalName: name },
    })
    const row = await tx.file.findUnique({ where: { id } })
    await tx.fileAccessLog.create({
      data: { fileId: id, userId: user.userId, action: 'RENAME' },
    })
    return { row, count: rows.count }
  })

  return ok(
    { file: { id: updated.row?.id, name: updated.row?.name, originalName: updated.row?.originalName }, versionsRenamed: updated.count },
    updated.count > 1 ? `已重命名（含 ${updated.count} 个历史版本）` : '文件已重命名',
  )
})

export const DELETE = apiHandler(async (_request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(_request)

  // 权限：上传人本人 / 条目审核人（经 file.requirementId 关联）/ ADMIN（DB 实时角色，防 JWT 降级窗口）
  const [dbUser, file] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.userId },
      select: { role: true, isActive: true },
    }),
    prisma.file.findUnique({
      where: { id: id },
      select: {
        id: true,
        requirementId: true,
        projectId: true,
        name: true,
        originalName: true,
        version: true,
        storagePath: true,
        uploadedById: true,
        requirement: { select: { id: true, name: true, reviewerId: true, status: true } },
        project: { select: { isArchived: true } },
      },
    }),
  ])
  if (!file) throw ApiError.notFound('文件不存在')

  // 归档冻结（只读态，同删除工程第 2 棒口径：不分角色一律拒绝）
  if (file.project.isArchived) {
    throw ApiError.badRequest('项目已归档，禁止删除文件；如需调整请先解除归档')
  }

  const isAdmin = !!dbUser && dbUser.isActive && dbUser.role === 'ADMIN'
  const isUploader = file.uploadedById === user.userId
  const isReviewer = !!file.requirement && file.requirement.reviewerId === user.userId
  if (!isAdmin && !isUploader && !isReviewer) {
    throw ApiError.forbidden('仅上传人本人、文件条目审核人或系统管理员可删除文件')
  }

  // 事务：删 File 行（FileAccessLog 随 FK Cascade）+ 条目一致性回退
  await prisma.$transaction(async (tx) => {
    await tx.file.delete({ where: { id: id } })

    if (file.requirementId && file.requirement?.status === 'SUBMITTED') {
      const remaining = await tx.file.count({ where: { requirementId: file.requirementId } })
      if (remaining === 0) {
        await tx.fileRequirement.update({
          where: { id: file.requirementId },
          data: { status: 'WAITING' },
        })
      }
    }
  })

  // 磁盘清理（事务外容错：失败仅 console.warn 不报错；resolveStoredFile 防路径越界）
  let storageCleaned = false
  const abs = resolveStoredFile(file.storagePath)
  if (!abs) {
    console.warn(`[file.delete] 存储路径非法，跳过磁盘清理：${file.storagePath}`)
  } else {
    try {
      const { unlink } = await import('fs/promises')
      await unlink(abs)
      storageCleaned = true
    } catch (e) {
      console.warn(`[file.delete] 磁盘文件删除失败（忽略）：${abs}`, e)
    }
  }

  // 审计留痕（§2.5）
  await logDelete(user.userId, 'file', id, {
    name: file.name,
    originalName: file.originalName,
    version: file.version,
    requirementId: file.requirementId,
    requirementName: file.requirement?.name ?? null,
    storageCleaned,
  }, file.projectId)

  return ok(
    { id: id, storageCleaned, requirement: file.requirementId ? { id: file.requirementId } : null },
    `文件「${file.originalName || file.name}」已删除`,
  )
})
