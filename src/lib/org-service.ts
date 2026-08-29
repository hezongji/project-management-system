/**
 * 组织架构数据服务（API 路由共用）—— 依据《开发文档-项目管理系统重构》§7.2
 */

import { prisma } from '@/lib/prisma'
import { buildDeptTree, DeptNode } from '@/lib/org-tree'

/** 拉全量部门 + 直属在职成员 → 部门树（51 人量级一次查完） */
export async function loadDeptTree(): Promise<DeptNode[]> {
  const [records, managers] = await Promise.all([
    prisma.department.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: {
        members: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            email: true,
            jobTitle: true,
            duties: true,
            phone: true,
            avatar: true,
            role: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    }),
  ])
  const managerNameById = new Map(managers.map((m) => [m.id, m.name]))
  return buildDeptTree(records, managerNameById)
}
