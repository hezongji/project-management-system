/**
 * /api/org-chart —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * GET 登录  架构图数据 { departments: 树（含成员数/负责人/成员摘要）,
 *                       externals: 按 type 分组（name+联系人计数+在职状态）,
 *                       stats: { userTotal, deptTotal, externalTotal } }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { loadDeptTree } from '@/lib/org-service'
import { ExternalOrgType } from '@prisma/client'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)

  const [tree, externals, userTotal, unassigned] = await Promise.all([
    loadDeptTree(),
    prisma.externalOrg.findMany({
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
        _count: { select: { contacts: true } },
      },
    }),
    prisma.user.count({ where: { isActive: true } }),
    // v1.2：无部门在职人员（通讯录「未分组」分组，避免人员"在外面"）
    prisma.user.findMany({
      where: { isActive: true, departmentId: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        jobTitle: true,
        phone: true,
        role: true,
      },
    }),
  ])

  const externalsByType: Record<string, Array<{ id: string; name: string; isActive: boolean; contactCount: number }>> = {}
  for (const t of Object.values(ExternalOrgType)) externalsByType[t] = []
  for (const e of externals) {
    ;(externalsByType[e.type] ??= []).push({
      id: e.id,
      name: e.name,
      isActive: e.isActive,
      contactCount: e._count.contacts,
    })
  }

  const countDepts = (nodes: typeof tree): number =>
    nodes.reduce((acc, n) => acc + 1 + countDepts(n.children), 0)

  return ok({
    departments: tree,
    unassigned,
    externals: externalsByType,
    stats: {
      userTotal,
      deptTotal: countDepts(tree),
      externalTotal: externals.length,
      unassignedTotal: unassigned.length,
    },
  })
})
