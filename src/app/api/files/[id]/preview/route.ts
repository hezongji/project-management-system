/**
 * GET /api/files/:id/preview —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * view 权限 → PDF/图片内联预览（Content-Type + inline disposition，§7.7），
 * 写 FileAccessLog(VIEW)（§5）。支持 HTTP Range（206 分段，PDF 分页/视频拖动）。
 *
 * 仅 image/* 与 application/pdf 允许内联预览；其余类型返回 415（前端可回退下载）。
 * 计划外文件（requirementId=null）回退项目 view 权限（见 lib/file-access.ts 文件头）。
 */

import { NextRequest } from 'next/server'
import { requireAuth, handleApiError, ApiError } from '@/lib/api-helpers'
import { prisma } from '@/lib/prisma'
import { accessFile } from '@/lib/file-access'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const PREVIEWABLE = ['image/', 'application/pdf']

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = requireAuth(request)
    const { id } = await context.params

    const file = await prisma.file.findUnique({
      where: { id },
      select: { mimeType: true },
    })
    if (!file) throw ApiError.notFound('文件不存在')

    const previewable = PREVIEWABLE.some((p) => file.mimeType.toLowerCase().startsWith(p))
    if (!previewable) {
      throw new ApiError(
        415,
        `该文件类型（${file.mimeType}）不支持内联预览，请使用下载`,
        'UNSUPPORTED_MEDIA_TYPE',
      )
    }

    return await accessFile(request, id, 'VIEW', user.userId)
  } catch (e) {
    return handleApiError(e)
  }
}
