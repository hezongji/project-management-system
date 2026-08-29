/**
 * /api/tasks/[id]/revisions/[version]/rollback —— 依据《开发文档-项目管理系统重构》§7.6
 *
 * POST  任务 edit   回滚到指定版本：「回滚=生成新修订，快照当前值」——
 *        ① 以当前值生成新 TaskRevision（version=当前 revision，快照=回滚前状态）
 *        ② 恢复目标版本快照的六字段，revision+1
 *        （因此 2 次修订 + 1 次回滚后 revision=4、修订记录 3 条；见 P1-5 报告说明）
 *
 * 联动：恢复触碰 status/assigneeId 时调 onTaskChanged（§7.5）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { ApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { rollbackRevision } from '@/lib/task-service'
import { onTaskChanged, EngineError } from '@/lib/phase-engine'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; version: string }> }

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id, version: versionStr } = await context.params
  await requireCan(user.userId, 'edit', { type: 'TASK', id })

  const version = Number(versionStr)
  if (!Number.isInteger(version) || version < 1) {
    throw ApiError.badRequest(`路径版本号非法：${versionStr}`)
  }

  const result = await prisma
    .$transaction(async (tx) => rollbackRevision(tx, id, user.userId, version))
    .catch((e: unknown): never => {
      if (e instanceof EngineError) {
        const status = e.status >= 400 && e.status < 600 ? e.status : 400
        throw new ApiError(status, e.message, e.code || 'BAD_REQUEST')
      }
      throw e
    })

  const linkage = await onTaskChanged(id).catch(() => null)

  return ok(
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
      /** 回滚动作本身写入的修订记录（快照回滚前状态） */
      rollbackRevision: result.revision,
      linkage,
    },
    `已回滚至版本 v${version}（当前 revision=${result.task.revision}）`,
  )
})
