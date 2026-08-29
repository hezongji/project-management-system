/**
 * /api/phases/[id]/skip —— 依据《开发文档-项目管理系统重构》§7.5、§8.2①
 *
 * POST  阶段 edit（权限引擎 can('edit', PHASE)）  跳过阶段
 *   body: { skippedNote: string 必填 }
 *
 * 规则：
 *  - skippedNote 必填（前端弹窗必填，§8.2①）
 *  - DONE 阶段不可跳过；已 SKIPPED 幂等返回（note 可更新）
 *  - 记 ActivityLog phase.skip（detail 含 note）
 *  - 跳过不改 actualEnd；progress 保持原值（项目进度均值不计 SKIPPED 分母，§7.5）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidateProject } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const skipSchema = z.object({
  skippedNote: z.string().trim().min(1, '跳过原因不能为空').max(500),
})

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PHASE', id: id })

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = skipSchema.parse(raw)

  const phase = await prisma.phase.findUnique({ where: { id: id } })
  if (!phase) throw ApiError.notFound('阶段不存在')
  if (phase.status === 'DONE') {
    throw ApiError.badRequest('阶段已完成，不能跳过')
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.phase.update({
      where: { id: id },
      data: { status: 'SKIPPED', skippedNote: body.skippedNote },
      include: { owner: { select: { id: true, name: true, avatar: true } } },
    })
    await tx.activityLog.create({
      data: {
        projectId: phase.projectId,
        userId: user.userId,
        action: 'phase.skip',
        detail: {
          phaseId: phase.id,
          phaseCode: phase.code,
          status: [phase.status, 'SKIPPED'],
          skippedNote: body.skippedNote,
        },
      },
    })
    return row
  })

  invalidateProject(phase.projectId)

  return ok({
    phase: updated,
    message: phase.status === 'SKIPPED' ? '跳过原因已更新' : '阶段已跳过',
  })
})
