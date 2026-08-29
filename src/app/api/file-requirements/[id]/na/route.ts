/**
 * POST /api/file-requirements/:id/na —— 依据《开发文档-项目管理系统重构》§7.7 / §5 / §6.1
 *
 * 标记不适用：body { reason }（必填备注）→ status=NA
 *   - 权限：requireCan('edit', FILE_REQ)（§7.7「项目 edit」）
 *   - NA 为归档豁免态（§7.7 归档拦截：required 且非 APPROVED/NA 才拦截）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { markRequirementNA, FileReviewError } from '@/lib/file-review'

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
    reason: z.string().trim().min(1, '不适用原因不能为空').max(1000, '原因不超过 1000 字'),
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
    const result = await markRequirementNA(user.userId, id, body.reason)
    return ok(result, '已标记为不适用')
  } catch (e) {
    toApiError(e)
  }
})
