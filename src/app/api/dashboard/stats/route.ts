import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { visibleProjectFilter } from '@/lib/data-visibility'

/**
 * GET /api/dashboard/stats → 工作台统计
 * P0-3 适配 schema v1.1：
 *  - Project.key → Project.code
 *  - Task 无 updatedAt，最近动态按 createdAt 排序
 *  - 组织成员数（organizationMember）→ 全公司在职人数（User.isActive）
 *  - 工时统计（timeEntry）在新 schema 中无数据源，固定返回 0（后续阶段接入）
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const userData = requireAuth(request)

  // 可见性（2026-08-21 权限 V2）：工作台统计仅本人成员项目范围，ADMIN 全量
  const memberScope = await visibleProjectFilter(userData.userId, userData.role)
  // Task 无 members 关联，改用「可见项目的 projectId 集合」过滤
  let taskScope: Record<string, unknown> = {}
  if (userData.role !== 'ADMIN') {
    const myProjects = await prisma.project.findMany({
      where: memberScope,
      select: { id: true },
    })
    const ids = myProjects.map((p) => p.id)
    taskScope = ids.length > 0 ? { projectId: { in: ids } } : { projectId: { in: [] } }
  }

  const [
    totalProjects,
    activeProjects,
    completedProjects,
    totalTasks,
    completedTasks,
    overdueTasks,
    recentProjects,
    upcomingTasks,
    recentActivities,
    totalTeamMembers,
  ] = await Promise.all([
    // 总项目数
    prisma.project.count({ where: memberScope }),

    // 活跃项目数
    prisma.project.count({ where: { ...memberScope, status: 'ACTIVE' } }),

    // 已完成项目数
    prisma.project.count({ where: { ...memberScope, status: 'COMPLETED' } }),

    // 总任务数
    prisma.task.count({ where: taskScope }),

    // 已完成任务数
    prisma.task.count({ where: { ...taskScope, status: 'DONE' } }),

    // 逾期任务数
    prisma.task.count({
      where: { ...taskScope, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
    }),

    // 最近项目
    prisma.project.findMany({
      where: memberScope,
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
      },
    }),

    // 即将到期的任务（7 天内）
    prisma.task.findMany({
      where: {
        OR: [{ assigneeId: userData.userId }, { creatorId: userData.userId }],
        status: { not: 'DONE' },
        dueDate: {
          gte: new Date(),
          lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { dueDate: 'asc' },
      take: 5,
      select: {
        id: true,
        title: true,
        description: true,
        dueDate: true,
        status: true,
        priority: true,
        project: { select: { id: true, code: true, name: true } },
      },
    }),

    // 最近活动：ActivityLog（schema v1.1 动态表，Task 无时间列不可用）
    prisma.activityLog.findMany({
      where: {
        OR: [
          { userId: userData.userId },
          { project: { members: { some: { userId: userData.userId } } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        action: true,
        detail: true,
        createdAt: true,
        project: { select: { id: true, code: true, name: true } },
        user: { select: { id: true, name: true } },
      },
    }),

    // 全公司在职人数（旧 organizationMember.count 的替代口径）
    prisma.user.count({ where: { isActive: true } }),
  ])

  return ok({
    totalProjects,
    activeProjects,
    completedProjects,
    totalTasks,
    completedTasks,
    overdueTasks,
    totalTeamMembers,
    recentProjects,
    upcomingTasks,
    recentActivities: recentActivities.map((activity) => ({
      id: activity.id,
      type: activity.action,
      title: activity.action,
      description: activity.project ? `项目：${activity.project.name}` : `操作人：${activity.user?.name ?? '-'}`,
      timestamp: activity.createdAt,
      project: activity.project,
    })),
  })
})
