/**
 * GET /api/files/:id/download —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * 条目 download 权限（visibleRequirementFilter 范围终审）→ 流式下载 +
 * 写 FileAccessLog(DOWNLOAD)（§5）。支持 HTTP Range（206 分段）。
 *
 * 计划外文件（requirementId=null）回退项目 view 权限（见 lib/file-access.ts 文件头）。
 */

import { NextRequest } from 'next/server'
import { requireAuth, handleApiError } from '@/lib/api-helpers'
import { accessFile } from '@/lib/file-access'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = requireAuth(request)
    const { id } = await context.params
    return await accessFile(request, id, 'DOWNLOAD', user.userId)
  } catch (e) {
    return handleApiError(e)
  }
}
