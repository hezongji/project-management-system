/**
 * /api/admin/storage —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * GET  ADMIN  存储统计：按项目聚合 File 表 size 用量
 *             返回 [{ projectId, projectName, fileCount, totalBytes, quotaBytes }]
 *             + 全局总量（totalBytes/totalFileCount）与配额口径
 *
 * 配额口径：从 SystemSetting.storageQuotaPerProjectBytes 读取（§7.10），
 *           无记录时回退常量 10GB（见 lib/system-settings.ts）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { loadSettings } from '@/lib/system-settings'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const quotaBytes = (await loadSettings()).storageQuotaPerProjectBytes as number

  const grouped = await prisma.file.groupBy({
    by: ['projectId'],
    _sum: { size: true },
    _count: { _all: true },
  })

  const projectIds = grouped.map((g) => g.projectId)
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true, code: true },
  })
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  const items = grouped.map((g) => ({
    projectId: g.projectId,
    projectName: projectMap.get(g.projectId)?.name ?? '(已删除项目)',
    projectCode: projectMap.get(g.projectId)?.code ?? null,
    fileCount: g._count._all,
    totalBytes: g._sum.size ?? 0,
    quotaBytes,
  }))
  // 用量降序（大头在前，便于前端条形图直观呈现）
  items.sort((a, b) => b.totalBytes - a.totalBytes)

  const totalBytes = items.reduce((acc, i) => acc + i.totalBytes, 0)
  const totalFileCount = items.reduce((acc, i) => acc + i.fileCount, 0)

  return ok({
    items,
    totalBytes,
    totalFileCount,
    quotaPerProjectBytes: quotaBytes,
  })
})
