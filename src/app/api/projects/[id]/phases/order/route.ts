/**
 * /api/projects/[id]/phases/order —— 依据《开发文档-项目管理系统重构》§8.2①
 *
 * PATCH  仅项目 OWNER / 全局 ADMIN  拖拽同级排序 → 批量 order
 *   body: { orders: [{ id, order }] }   ← 必须覆盖项目全部阶段，order 为 1..N 的排列
 *
 * 说明：
 *  - 权限按 §8.2① 字面「仅项目 OWNER/ADMIN」精确判定（项目 MANAGER 虽有项目级
 *    edit 权限但不含排序，避免影响流程语义）
 *  - 事务内逐条更新 + ActivityLog（project.phase_reorder）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { invalidateProject } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const orderSchema = z.object({
  orders: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        order: z.number().int().min(1).max(999),
      }),
    )
    .min(1, '排序列表不能为空'),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true, code: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  // §8.2①：仅项目 OWNER / ADMIN
  if (user.role !== 'ADMIN') {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: user.userId } },
      select: { role: true },
    })
    if (member?.role !== 'OWNER') {
      throw ApiError.forbidden('只有项目负责人或系统管理员可以调整阶段顺序')
    }
  }

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = orderSchema.parse(raw)

  const phases = await prisma.phase.findMany({
    where: { projectId: id },
    select: { id: true },
  })
  const phaseIds = new Set(phases.map((p) => p.id))

  // 校验：全覆盖、无外来 id、order 是 1..N 的排列
  const seenIds = new Set<string>()
  const seenOrders = new Set<number>()
  for (const item of body.orders) {
    if (!phaseIds.has(item.id)) {
      throw ApiError.badRequest(`阶段 ${item.id} 不属于该项目`)
    }
    if (seenIds.has(item.id)) throw ApiError.badRequest('排序列表存在重复阶段')
    seenIds.add(item.id)
    if (seenOrders.has(item.order)) throw ApiError.badRequest('排序值存在重复')
    seenOrders.add(item.order)
  }
  if (seenIds.size !== phases.length) {
    throw ApiError.badRequest('排序列表必须覆盖项目全部阶段')
  }
  const N = phases.length
  for (let i = 1; i <= N; i++) {
    if (!seenOrders.has(i)) {
      throw ApiError.badRequest(`排序值必须是 1..${N} 的连续排列（缺少 ${i}）`)
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    for (const item of body.orders) {
      await tx.phase.update({
        where: { id: item.id },
        data: { order: item.order },
      })
    }
    await tx.activityLog.create({
      data: {
        projectId: id,
        userId: user.userId,
        action: 'project.phase_reorder',
        detail: { orders: body.orders },
      },
    })
    return tx.phase.findMany({
      where: { projectId: id },
      select: { id: true, code: true, order: true },
      orderBy: { order: 'asc' },
    })
  })

  invalidateProject(id)

  return ok({ phases: updated })
})
