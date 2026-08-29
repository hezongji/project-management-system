/**
 * /api/admin/audit-logs —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * GET  ADMIN  审计日志列表（源：ActivityLog）
 *             支持 ?projectId=&userId=&action= 过滤，createdAt 倒序分页
 *             返回含 user 摘要（name/email）、project 名称
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, parsePagination } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const { searchParams } = new URL(request.url)
  const projectId = (searchParams.get('projectId') || '').trim()
  const userId = (searchParams.get('userId') || '').trim()
  const action = (searchParams.get('action') || '').trim()
  const { page, limit, skip } = parsePagination(request, 20)

  const where: Record<string, unknown> = {}
  if (projectId) where.projectId = projectId
  if (userId) where.userId = userId
  if (action) where.action = { contains: action, mode: 'insensitive' }

  const [total, items] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ])

  const data = items.map((log) => ({
    id: log.id,
    projectId: log.projectId,
    projectName: log.project?.name ?? null,
    projectCode: log.project?.code ?? null,
    userId: log.userId,
    userName: log.user?.name ?? null,
    userEmail: log.user?.email ?? null,
    action: log.action,
    detail: log.detail,
    createdAt: log.createdAt,
  }))

  return ok({
    items: data,
    pagination: {
      page,
      limit,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  })
})
