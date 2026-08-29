/**
 * POST /api/file-requirements/:id/obsolete —— 依据《开发文档-项目管理系统重构》§5 / §7.7 / §6.1
 *
 * 作废：body { reason }（必填备注）→ status=OBSOLETED
 *   - 权限：requireCan('edit', FILE_REQ)（§7.7 语义：项目 edit；文档未单列 obsolete 端点，
 *     任务书允许「独立接口」，此处落地独立 POST 端点，与 PATCH 改状态等价但强制备注）
 *   - 写 FileAccessLog(OBSOLETE)（若条目已有文件）+ 记 ActivityLog file.obsolete
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { obsoleteRequirement, FileReviewError } from '@/lib/file-review'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** FileReviewError → api-helpers ApiError（统一响应壳） */
function toApiError(e: unknown): never {
  if (e instanceof FileReviewError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 400
    throw new ApiError(status, e.message, e.code || 'BAD_REQUEST')
  }
  throw e
}

const schema = z
  .object({
    reason: z.string().trim().min(1, '作废原因不能为空').max(1000, '原因不超过 1000 字'),
  })
  .strict()

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'FILE_REQ', id: id })

  const body = schema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )

  try {
    const result = await obsoleteRequirement(user.userId, id, body.reason)
    return ok(result, '已作废')
  } catch (e) {
    toApiError(e)
  }
})
