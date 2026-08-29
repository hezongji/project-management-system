/**
 * /api/projects/[id]/members —— 依据《开发文档-项目管理系统重构》§7.4（P0-8）
 *
 * GET    项目 view   成员列表（含 user 摘要 + role + title）
 * POST   项目 edit   加成员 { userId? | userIds?[], role?, title? }
 *                    —— 同时把新成员拉入项目群会话（PROJECT_GROUP）+ 失效权限缓存
 * DELETE /:memberId 移除（见 [memberId]/route.ts，项目 edit 权限）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidatePerms, invalidateProject } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// ───────────────────────────── GET：成员列表 ─────────────────────────────

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const members = await prisma.projectMember.findMany({
    where: { projectId: id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          jobTitle: true,
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })

  return ok({
    members: members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      avatar: m.user.avatar,
      jobTitle: m.user.jobTitle,
      department: m.user.department?.name ?? null,
      role: m.role,
      title: m.title,
      joinedAt: m.joinedAt,
    })),
  })
})

// ───────────────────────────── POST：加成员 ─────────────────────────────

const addSchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    userIds: z.array(z.string().trim().min(1)).min(1).optional(),
    role: z.enum(['OWNER', 'MANAGER', 'MEMBER', 'VIEWER']).optional(),
    title: z.string().trim().max(50).nullable().optional(),
  })
  .refine((d) => d.userId || (d.userIds && d.userIds.length > 0), {
    message: '缺少 userId / userIds',
  })

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const body = addSchema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )
  const ids = Array.from(
    new Set(body.userIds ?? (body.userId ? [body.userId] : [])),
  )

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true },
  })
  if (users.length !== ids.length) {
    throw ApiError.badRequest('部分成员不存在或已离职')
  }

  // 已存在成员跳过
  const existingRows = await prisma.projectMember.findMany({
    where: { projectId: id, userId: { in: ids } },
    select: { userId: true },
  })
  const existingIds = new Set(existingRows.map((m) => m.userId))
  const toAdd = ids.filter((id) => !existingIds.has(id))

  if (toAdd.length > 0) {
    const role = body.role ?? 'MEMBER'
    // P2-3 修复：加成员+拉群+NOTIFY 包进单事务（PG NOTIFY 事务内投递，回滚不发出）
    await prisma.$transaction(async (tx) => {
      await tx.projectMember.createMany({
        data: toAdd.map((id) => ({
          projectId: id,
          userId: id,
          role,
          title: body.title ?? null,
        })),
      })

      // 同步项目群会话：把新成员拉入 PROJECT_GROUP（若存在）
      const group = await tx.conversation.findFirst({
        where: { projectId: id, type: 'PROJECT_GROUP' },
        select: { id: true },
      })
      if (group) {
        const existingConv = await tx.conversationMember.findMany({
          where: { conversationId: group.id, userId: { in: toAdd } },
          select: { userId: true },
        })
        const inConv = new Set(existingConv.map((m) => m.userId))
        const toJoin = toAdd.filter((id) => !inConv.has(id))
        if (toJoin.length > 0) {
          await tx.conversationMember.createMany({
            data: toJoin.map((id) => ({
              conversationId: group.id,
              userId: id,
              role: 'MEMBER',
            })),
          })
          await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
            event: 'conv:created',
            conversation: {
              id: group.id,
              type: 'PROJECT_GROUP',
              projectId: id,
              members: toJoin.map((id) => ({ userId: id })),
            },
          })})`
        }
      }
    })
  }

  // 权限缓存：新成员获得项目可见性、项目级缓存整体失效
  for (const id of toAdd) invalidatePerms(id)
  invalidateProject(id)

  return ok(
    { added: toAdd.length, skipped: existingIds.size },
    toAdd.length > 0 ? `已添加 ${toAdd.length} 名成员` : '所选用户已是项目成员',
  )
})
