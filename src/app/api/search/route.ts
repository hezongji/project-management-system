/**
 * /api/search —— 全局搜索（P2-2）
 *
 * GET /api/search?q= 登录  三源 LIKE 模糊搜索（PostgreSQL case-insensitive）：
 *   1. 项目：code / name（各取前 5，含归档）
 *   2. 任务：title（各取前 5，含所属项目 code 供跳转）
 *   3. 成员：name / email（仅在职，各取前 5）
 * 返回分组结果 { projects, tasks, users }，前端顶栏搜索框防抖消费。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { visibleProjectFilter, visibleTaskFilter } from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const userData = requireAuth(request)

  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim()
  if (!q) {
    return ok({ projects: [], tasks: [], users: [] })
  }

  const like = { contains: q, mode: 'insensitive' as const }

  // 可见性（2026-08-21 修复 P0-2）：项目/任务分支仅返回用户可见范围（非 ADMIN=成员项目），
  // 堵住非成员用全局搜索枚举客户名录与项目编号
  const projFilter = await visibleProjectFilter(userData.userId, userData.role)
  const taskFilter = await visibleTaskFilter(userData.userId, userData.role)

  const [projects, tasks, users] = await Promise.all([
    prisma.project.findMany({
      where: { OR: [{ code: like }, { name: like }], ...projFilter },
      select: { id: true, code: true, name: true, isArchived: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
    prisma.task.findMany({
      where: { title: like, ...taskFilter },
      select: {
        id: true,
        title: true,
        projectId: true,
        project: { select: { code: true } },
      },
      // Task 模型无 updatedAt 字段，用 id desc 近似"新任务优先"
      orderBy: { id: 'desc' },
      take: 5,
    }),
    prisma.user.findMany({
      where: { isActive: true, OR: [{ name: like }, { email: like }] },
      select: { id: true, name: true, email: true, avatar: true },
      orderBy: { name: 'asc' },
      take: 5,
    }),
  ])

  return ok({ projects, tasks, users })
})
