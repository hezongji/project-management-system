/**
 * /api/tasks/[id]/revisions —— 依据《开发文档-项目管理系统重构》§7.6 / §5 TaskRevision
 *
 * GET  /api/tasks/:id/revisions   任务 view   修订历史（version 倒序分页，含快照与操作人）
 * POST /api/tasks/:id/revisions   任务 edit   ★修订：body { changeSummary(>10字), patch:{...} }
 *        流程（lib/task-service.applyRevision，事务内）：
 *          ① 服务端快照旧值 → TaskRevision(version=修订前 revision)
 *          ② 应用 patch（白名单六字段）
 *          ③ task.revision+1
 *        patch 无实际变更 / changeSummary ≤10 字 / 非白名单字段 → 400
 *
 * 联动：patch 触碰 status/assigneeId 时调 onTaskChanged（§7.5 状态机）。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  ok,
  okPage,
  created,
  parsePagination,
  requireAuth,
} from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { applyRevision } from '@/lib/task-service'
import { onTaskChanged, EngineError } from '@/lib/phase-engine'
import { ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/** phase-engine / task-service 的 EngineError → api-helpers ApiError（统一响应壳） */
function toApiError(e: unknown): never {
  if (e instanceof EngineError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 400
    throw new ApiError(status, e.message, e.code || 'BAD_REQUEST')
  }
  throw e
}

// ───────────────────────────── GET：修订历史 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'view', { type: 'TASK', id })

  const { page, limit, skip } = parsePagination(request, 20)

  const where = { taskId: id }
  const [revisions, total] = await Promise.all([
    prisma.taskRevision.findMany({
      where,
      orderBy: { version: 'desc' },
      include: { changedBy: { select: { id: true, name: true, avatar: true } } },
      skip,
      take: limit,
    }),
    prisma.taskRevision.count({ where }),
  ])

  return okPage(revisions, page, limit, total)
})

// ───────────────────────────── POST：★修订 ─────────────────────────────

const revisionSchema = z
  .object({
    changeSummary: z.string(),
    patch: z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        assigneeId: z.string().nullable().optional(),
        dueDate: z.string().nullable().optional(),
      })
      .strict(),
  })
  .strict()

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params
  await requireCan(user.userId, 'edit', { type: 'TASK', id })

  const body = revisionSchema.parse(await request.json())

  const result = await prisma
    .$transaction(async (tx) =>
      applyRevision(tx, id, user.userId, body.changeSummary, body.patch),
    )
    .catch(toApiError)

  // status/assignee 变更 → 阶段状态机联动（§7.5）；失败不阻断修订本身
  const linkage = await onTaskChanged(id).catch(() => null)

  return created(
    {
      task: {
        id: result.task.id,
        title: result.task.title,
        status: result.task.status,
        priority: result.task.priority,
        assigneeId: result.task.assigneeId,
        dueDate: result.task.dueDate,
        revision: result.task.revision,
      },
      revision: result.revision,
      linkage,
    },
    `修订成功：当前版本 v${result.task.revision}`,
  )
})
