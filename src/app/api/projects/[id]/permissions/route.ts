/**
 * /api/projects/[id]/permissions —— 资源 ACL 权限矩阵（audit P1-2）
 *
 * GET  项目 view   列出该项目的 ResourcePermission 授权（USER/DEPARTMENT/ROLE + 八键 perms）
 * PUT  项目 edit   覆盖式批量设置：body { grants: [{ principalType, principalId, perms }] }
 *                  —— 先删除该项目全部 PROJECT 类 ACL，再写入新授权（perms 至少一键为 true）
 *                  —— 写后 invalidateProject + 受影响用户 invalidatePerms
 *
 * perms 格式与 lib/permission.ts parseAclPerms 一致：
 *   { view, edit, delete, assign, upload, download, approve, archive } 布尔八键，
 *   仅 `=== true` 生效；ACL 为 ∪ 追加授权（不设减权），见 §6.1 步骤 3。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import {
  ACTIONS,
  requireCan,
  invalidatePerms,
  invalidateProject,
} from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** 八键 perms（与 lib/permission.ts Action 全集一致） */
const permsSchema = z.object({
  view: z.boolean().optional(),
  edit: z.boolean().optional(),
  delete: z.boolean().optional(),
  assign: z.boolean().optional(),
  upload: z.boolean().optional(),
  download: z.boolean().optional(),
  approve: z.boolean().optional(),
  archive: z.boolean().optional(),
})

const grantSchema = z.object({
  principalType: z.enum(['USER', 'DEPARTMENT', 'ROLE']),
  principalId: z.string().trim().min(1),
  perms: permsSchema,
})

const putSchema = z.object({
  grants: z.array(grantSchema).default([]),
})

/** ROLE 主体合法值：项目角色 ∪ 全局角色（与 principalMatch 语义一致） */
const ROLE_PRINCIPALS = new Set([
  'OWNER',
  'MANAGER',
  'MEMBER',
  'VIEWER',
  'ADMIN',
  'PROJECT_MANAGER',
])

// ───────────────────────────── GET：授权列表 ─────────────────────────────

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const rows = await prisma.resourcePermission.findMany({
    where: { resourceType: 'PROJECT', resourceId: id },
    select: {
      id: true,
      principalType: true,
      principalId: true,
      perms: true,
      createdAt: true,
      grantedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ principalType: 'asc' }, { createdAt: 'asc' }],
  })

  // 解析主体显示名
  const userIds = rows.filter((r) => r.principalType === 'USER').map((r) => r.principalId)
  const deptIds = rows
    .filter((r) => r.principalType === 'DEPARTMENT')
    .map((r) => r.principalId)
  const [users, depts] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    deptIds.length
      ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ])
  const userName = new Map(users.map((u) => [u.id, u.name]))
  const deptName = new Map(depts.map((d) => [d.id, d.name]))

  return ok({
    grants: rows.map((r) => ({
      id: r.id,
      principalType: r.principalType,
      principalId: r.principalId,
      principalName:
        r.principalType === 'USER'
          ? userName.get(r.principalId) ?? '（用户已删除）'
          : r.principalType === 'DEPARTMENT'
            ? deptName.get(r.principalId) ?? '（部门已删除）'
            : r.principalId,
      perms: r.perms,
      grantedBy: r.grantedBy?.name ?? null,
      createdAt: r.createdAt,
    })),
  })
})

// ───────────────────────────── PUT：覆盖式批量设置 ─────────────────────────────

export const PUT = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: id })

  const project = await prisma.project.findUnique({
    where: { id: id },
    select: { id: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const body = putSchema.parse(
    await request.json().catch(() => {
      throw ApiError.badRequest('请求体必须是 JSON')
    }),
  )

  // 校验主体存在性 + 去重（同主体仅保留最后一条）
  const dedup = new Map<string, z.infer<typeof grantSchema>>()
  for (const g of body.grants) {
    const anyTrue = ACTIONS.some((a) => g.perms[a] === true)
    if (!anyTrue) continue // 全 false 等价于无授权，直接丢弃
    dedup.set(`${g.principalType}:${g.principalId}`, g)
  }
  const grants = Array.from(dedup.values())

  const checkUserIds = grants.filter((g) => g.principalType === 'USER').map((g) => g.principalId)
  const checkDeptIds = grants
    .filter((g) => g.principalType === 'DEPARTMENT')
    .map((g) => g.principalId)
  const roleIds = grants.filter((g) => g.principalType === 'ROLE').map((g) => g.principalId)

  const [existUsers, existDepts] = await Promise.all([
    checkUserIds.length
      ? prisma.user.findMany({ where: { id: { in: checkUserIds } }, select: { id: true } })
      : Promise.resolve([]),
    checkDeptIds.length
      ? prisma.department.findMany({ where: { id: { in: checkDeptIds } }, select: { id: true } })
      : Promise.resolve([]),
  ])
  if (existUsers.length !== new Set(checkUserIds).size) {
    throw ApiError.badRequest('部分授权用户不存在')
  }
  if (existDepts.length !== new Set(checkDeptIds).size) {
    throw ApiError.badRequest('部分授权部门不存在')
  }
  for (const rid of roleIds) {
    if (!ROLE_PRINCIPALS.has(rid)) {
      throw ApiError.badRequest(`无效的角色主体：${rid}（可选：${Array.from(ROLE_PRINCIPALS).join('/')}）`)
    }
  }

  // 覆盖式写入：删除旧 ACL → 写入新 ACL（同一事务）
  await prisma.$transaction([
    prisma.resourcePermission.deleteMany({
      where: { resourceType: 'PROJECT', resourceId: id },
    }),
    ...grants.map((g) => {
      const perms: Record<string, boolean> = {}
      for (const a of ACTIONS) perms[a] = g.perms[a] === true
      return prisma.resourcePermission.create({
        data: {
          resourceType: 'PROJECT',
          resourceId: id,
          principalType: g.principalType,
          principalId: g.principalId,
          perms,
          grantedById: user.userId,
        },
      })
    }),
  ])

  // 缓存失效：项目级整体失效；USER 主体精准失效；DEPARTMENT/ROLE 波及多人 → 全清
  invalidateProject(id)
  const broadChange = grants.some((g) => g.principalType !== 'USER')
  if (broadChange) {
    invalidatePerms()
  } else {
    for (const g of grants) invalidatePerms(g.principalId)
  }

  return ok({ count: grants.length }, `权限矩阵已保存（${grants.length} 条授权）`)
})
