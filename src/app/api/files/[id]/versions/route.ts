/**
 * GET /api/files/:id/versions —— 网盘化（20260830-drive-war W2，spec §5）
 *
 * 自由文件版本列表（同 folderId+originalName 活跃行，version 降序）；
 * 条目文件版本列表（同 requirementId，沿用条目时间线语义）。
 * 权限：view（自由文件=文件夹级；条目文件=FILE_REQ 范围终审）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  const file = await prisma.file.findUnique({
    where: { id },
    select: {
      id: true, requirementId: true, projectId: true, folderId: true,
      originalName: true, deletedAt: true,
    },
  })
  if (!file || file.deletedAt) throw ApiError.notFound('文件不存在或已在回收站')

  if (file.requirementId) {
    await requireCan(user.userId, 'view', { type: 'FILE_REQ', id: file.requirementId })
    const versions = await prisma.file.findMany({
      where: { requirementId: file.requirementId },
      select: {
        id: true, name: true, originalName: true, version: true, size: true,
        mimeType: true, createdAt: true, uploadedBy: { select: { name: true } },
      },
      orderBy: { version: 'desc' },
    })
    return ok({ items: versions, currentId: file.id, kind: 'requirement' })
  }

  if (file.folderId) {
    await requireCan(user.userId, 'view', { type: 'FILE_FOLDER', id: file.folderId })
  } else {
    await requireCan(user.userId, 'view', { type: 'PROJECT', id: file.projectId })
  }
  const versions = await prisma.file.findMany({
    where: {
      folderId: file.folderId,
      originalName: file.originalName,
      requirementId: null,
      deletedAt: null,
    },
    select: {
      id: true, name: true, originalName: true, version: true, size: true,
      mimeType: true, createdAt: true, uploadedBy: { select: { name: true } },
    },
    orderBy: { version: 'desc' },
  })
  return ok({ items: versions, currentId: file.id, kind: 'free' })
})
