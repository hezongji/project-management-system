/**
 * GET /api/files/search?q= —— 网盘化（20260830-drive-war W2，spec §5）
 *
 * 跨项目文件名搜索（owner 需求：像网盘一样找文件）：
 *  - 范围 = 用户可见项目（成员 ∪ 管理员额外可见；ADMIN 全量）
 *  - 匹配 originalName/name contains（PG insensitive）
 *  - 自由文件（requirementId=null）：项目成员即可见（文件夹 ACL 只加不减）
 *    条目文件：按 visibleRequirementFilter 范围终审（PRIVATE/RESTRICTED 不越权漏出）
 *  - 默认限 50 条；返回带项目名/目录路径面包屑；软删过滤；条目文件仅最新版本行
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { visibleRequirementFilter } from '@/lib/permission'
import { latestVersionFilter } from '@/lib/drive'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q || q.length < 1) throw ApiError.badRequest('缺少搜索词 q')

  const me = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { role: true, isActive: true, departmentId: true },
  })
  if (!me || !me.isActive) throw ApiError.forbidden('用户无效')

  const isAdmin = me.role === 'ADMIN'

  // 条目文件候选（范围终审过滤）
  const reqFiles = await prisma.file.findMany({
    where: {
      deletedAt: null,
      requirementId: { not: null },
      requirement: await visibleRequirementFilter(user.userId),
      OR: [
        { originalName: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true, originalName: true, name: true, version: true, size: true, mimeType: true,
      createdAt: true, projectId: true, folderId: true, requirementId: true,
      project: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // 自由文件候选（成员项目范围）
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({ where: { userId: user.userId }, select: { projectId: true } })
  const memberProjectIds = memberships.map((m) => m.projectId)
  const freeFiles = isAdmin
    ? await prisma.file.findMany({
        where: {
          deletedAt: null,
          requirementId: null,
          OR: [
            { originalName: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, originalName: true, name: true, version: true, size: true, mimeType: true,
          createdAt: true, projectId: true, folderId: true, requirementId: true,
          project: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    : memberProjectIds.length > 0
      ? await prisma.file.findMany({
          where: {
            deletedAt: null,
            requirementId: null,
            projectId: { in: memberProjectIds },
            OR: [
              { originalName: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true, originalName: true, name: true, version: true, size: true, mimeType: true,
            createdAt: true, projectId: true, folderId: true, requirementId: true,
            project: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      : []

  // 条目文件取最新版本行（同 requirementId max version）；自由文件取最新版本行
  const latestReq = [] as typeof reqFiles
  const seenReq = new Map<string, typeof reqFiles[number]>()
  for (const f of reqFiles) {
    const key = f.requirementId as string
    const cur = seenReq.get(key)
    if (!cur || f.version > cur.version) seenReq.set(key, f)
  }
  latestReq.push(...Array.from(seenReq.values()))

  // 合并（自由文件按 folderId+originalName 取最新）
  const latestFree = latestVersionFilter(freeFiles)
  const merged = [...latestFree, ...latestReq]
    .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
    .slice(0, 50)

  // 目录面包屑（folder path → names 一次查询）
  const folderIds = Array.from(new Set(merged.map((f) => f.folderId).filter((x): x is string => !!x)))
  const folders = folderIds.length
    ? await prisma.fileCatalog.findMany({
        where: { id: { in: folderIds } },
        select: { id: true, name: true, path: true },
      })
    : []
  const allIds = new Set(
    folders.flatMap((f) => f.path.split('/').filter(Boolean)).concat(folderIds),
  )
  const nameRows = allIds.size
    ? await prisma.fileCatalog.findMany({ where: { id: { in: Array.from(allIds) } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]))
  const folderById = new Map(folders.map((f) => [f.id, f]))

  return ok({
    q,
    items: merged.map((f) => {
      const folder = f.folderId ? folderById.get(f.folderId) : null
      const crumb = folder
        ? folder.path
            .split('/')
            .filter(Boolean)
            .map((id) => nameById.get(id))
            .filter(Boolean)
            .join(' / ')
        : ''
      return {
        id: f.id,
        name: f.originalName,
        version: f.version,
        size: f.size,
        mimeType: f.mimeType,
        createdAt: f.createdAt,
        isRequirement: !!f.requirementId,
        requirementId: f.requirementId,
        projectId: f.projectId,
        projectName: f.project?.name ?? '',
        folderId: f.folderId,
        folderPath: crumb,
      }
    }),
    total: merged.length,
  })
})
