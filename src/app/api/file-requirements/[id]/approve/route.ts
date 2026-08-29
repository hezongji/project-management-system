/**
 * POST /api/file-requirements/:id/approve —— 依据《开发文档-项目管理系统重构》§7.7 / §5 / §6.1
 *
 * 审核通过：body { comment? } → status=APPROVED
 *   - 权限：requireCan('approve', FILE_REQ)（§6.1 阶段负责人可 file.approve，默认阶段负责人
 *     = Phase.ownerId，由权限引擎运行时解析；ADMIN 直通）
 *   - 仅 SUBMITTED / REVIEWING 可审核；其余状态 409
 *   - 通知责任人（Notification FILE_APPROVED + IM notify:push）+ 写 FileAccessLog(APPROVE)
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { approveRequirement, FileReviewError } from '@/lib/file-review'

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
  .object({ comment: z.string().trim().max(1000, '审核意见不超过 1000 字').optional() })
  .strict()

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'approve', { type: 'FILE_REQ', id: id })

  const body = schema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )

  try {
    const result = await approveRequirement(user.userId, id, body.comment ?? '')
    return ok(result, '文件已通过审核')
  } catch (e) {
    toApiError(e)
  }
})
