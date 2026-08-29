/**
 * DELETE /api/files/:id —— 删除工程第 4 棒（文件域，§2/§2.5）
 *
 * 物理删除单个文件版本（DB 行 + 尽力删磁盘文件）。
 * 权限：上传人本人 / 所属条目审核人（requirement.reviewerId，计划外文件
 * requirementId=null 时无此路径）/ ADMIN（DB 实时角色）。
 * 级联：FileAccessLog 随 File 行 FK Cascade（schema 既定行为，详见棒报告）。
 * 一致性：条目文件删尽且条目仍为 SUBMITTED（未进入审核）时回退 WAITING，
 * 避免「已提交但无文件」幽灵态；REVIEWING/APPROVED 等已进入审核的状态不动，
 * 由 reject/obsolete 流程收口。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { logDelete } from '@/lib/delete-helpers'
import { resolveStoredFile } from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

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
