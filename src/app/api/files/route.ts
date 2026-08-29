/**
 * GET /api/files —— 计划外文件（临时文件）列表（IM App v1.1 战役 W4，2026-08-29）
 *
 * 按项目+目录列出 requirementId=null 的计划外文件，供 PC 端「临时文件」管理：
 *   查询：?projectId=&catalogId=（必填）
 *   权限：requireCan('view', PROJECT)
 *   实现：File 无 catalogId 列（storagePath 前缀即目录归属），where 用
 *   storagePath startsWith `{projectId}/{catalogId}/` 前缀匹配，不加列。
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
      storagePath: { startsWith: `${projectId}/${catalogId}/` },
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
