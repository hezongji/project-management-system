/**
 * GET /api/files —— 计划外文件（临时文件）列表（IM App v1.1 战役 W4，2026-08-29）
 *
 * 按项目+目录列出 requirementId=null 的计划外文件，供 PC 端「临时文件」管理：
 *   查询：?projectId=&catalogId=（必填）
 *   权限：requireCan('view', PROJECT)
 *   实现（网盘化 20260830-drive-war）：目录归属改按 File.folderId 权威列查询
 *   （移动已改 DB-only，storagePath 物理路径不再变更，前缀匹配会漏移入/误含移出文件）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const projectId = request.nextUrl.searchParams.get('projectId')?.trim() ?? ''
  const catalogId = request.nextUrl.searchParams.get('catalogId')?.trim() ?? ''
  if (!projectId || !catalogId) {
    throw ApiError.badRequest('缺少 projectId / catalogId')
  }

  // 目录必须存在且属于该项目（防任意前缀探测）
  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: catalogId },
    select: { id: true, projectId: true },
  })
  if (!catalog || catalog.projectId !== projectId) {
    throw ApiError.notFound('目录不存在')
  }

  await requireCan(user.userId, 'view', { type: 'PROJECT', id: projectId })

  const items = await prisma.file.findMany({
    where: {
      requirementId: null,
      projectId,
      folderId: catalogId, // ★ 网盘化：逻辑目录权威列（软删过滤）
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      originalName: true,
      size: true,
      mimeType: true,
      version: true,
      checksum: true,
      createdAt: true,
      uploadedById: true,
      uploadedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return ok({ items })
})
