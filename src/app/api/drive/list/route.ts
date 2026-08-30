/**
 * GET /api/drive/list —— 网盘化（20260830-drive-war W2，spec §5）
 *
 * 项目网盘目录视图：文件夹 + 自由文件 + 交付条目 合并列表（Windows 资源管理器式混排）。
 *   ?projectId=  （必填）
 *   &folderId=  目录 id（缺省=根级：仅返回根级文件夹）
 *   &page=      页码（默认 1）
 *   &pageSize=  页大小（默认 50，上限 100）
 *   &view=recycle 回收站视图（已删文件+已删目录，MEMBER 仅见自己删的，MANAGER+ 见全部）
 *
 * 权限：项目 view（非成员整棵树不可见=owner 底线需求）；
 * 条目行按 visibleRequirementFilter 过滤（范围终审对齐）；
 * 自由文件行只展示「最新版本」（同 folderId+originalName 取 max version，spec D4）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, visibleRequirementFilter } from '@/lib/permission'
import { getLiveFolder, breadcrumb, latestVersionFilter, retainDaysLeft, isManagerPlus } from '@/lib/drive'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId') ?? ''
  const folderId = url.searchParams.get('folderId') ?? ''
  const view = url.searchParams.get('view') ?? ''
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') ?? 50) || 50))

  if (!projectId) throw ApiError.badRequest('缺少 projectId')
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: projectId })

  // ── 回收站视图 ──
  if (view === 'recycle') {
    const managerPlus = await isManagerPlus(user.userId, projectId)
    const [deletedFiles, deletedFolders] = await Promise.all([
      prisma.file.findMany({
        where: {
          projectId,
          deletedAt: { not: null },
          ...(managerPlus ? {} : { deletedById: user.userId }),
        },
        select: {
          id: true, name: true, originalName: true, size: true, mimeType: true,
          version: true, folderId: true, deletedAt: true, deletedById: true,
          folder: { select: { name: true, path: true } },
          uploadedBy: { select: { name: true } },
        },
        orderBy: { deletedAt: 'desc' },
        take: 200,
      }),
      prisma.fileCatalog.findMany({
        where: {
          projectId,
          deletedAt: { not: null },
          ...(managerPlus ? {} : { deletedById: user.userId }),
        },
        select: {
          id: true, name: true, kind: true, path: true,
          deletedAt: true, deletedById: true, parentId: true,
        },
        orderBy: { deletedAt: 'desc' },
        take: 200,
      }),
    ])
    // 目录去重：连带删除的子目录不重复展示
    const deletedIds = new Set(deletedFolders.map((f) => f.id))
    const folderRoots = deletedFolders.filter((f) => !f.parentId || !deletedIds.has(f.parentId))

    return ok({
      files: deletedFiles.map((f) => ({
        id: f.id,
        name: f.originalName,
        size: f.size,
        mimeType: f.mimeType,
        version: f.version,
        folderName: f.folder?.name ?? '',
        folderId: f.folderId,
        deletedAt: f.deletedAt,
        daysLeft: retainDaysLeft(f.deletedAt as Date),
        deletedByMe: f.deletedById === user.userId,
        uploader: f.uploadedBy?.name ?? '',
      })),
      folders: folderRoots.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        path: f.path,
        deletedAt: f.deletedAt,
        daysLeft: retainDaysLeft(f.deletedAt as Date),
        deletedByMe: f.deletedById === user.userId,
      })),
    })
  }

  // ── 常规视图 ──
  const folder = folderId ? await getLiveFolder(folderId, projectId) : null

  const [folders, freeFiles, requirements] = await Promise.all([
    // 子文件夹（软删过滤）
    prisma.fileCatalog.findMany({
      where: { projectId, parentId: folderId || null, deletedAt: null },
      select: {
        id: true, name: true, kind: true, path: true, order: true, remark: true,
        _count: { select: { requirements: true, children: true } },
      },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    }),
    // 自由文件（最新版本行）
    folderId
      ? prisma.file.findMany({
          where: { projectId, folderId, requirementId: null, deletedAt: null },
          select: {
            id: true, name: true, originalName: true, size: true, mimeType: true,
            version: true, createdAt: true, uploadedBy: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })
      : Promise.resolve([]),
    // 交付条目（范围终审过滤）
    folderId
      ? prisma.fileRequirement.findMany({
          where: { catalogId: folderId, AND: [await visibleRequirementFilter(user.userId)] },
          select: {
            id: true, name: true, code: true, status: true, scope: true,
            required: true, dueDate: true, phaseCode: true,
            owner: { select: { id: true, name: true } },
            _count: { select: { files: true } },
          },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ])

  // 最新版本过滤 + 合并排序（文件夹 → 文件/条目按名称）
  const latestFiles = latestVersionFilter(freeFiles).map((f) => ({
    type: 'file' as const,
    id: f.id,
    name: f.originalName,
    size: f.size,
    mimeType: f.mimeType,
    version: f.version,
    createdAt: f.createdAt,
    uploader: f.uploadedBy?.name ?? '',
    uploaderId: f.uploadedBy?.id ?? '',
  }))
  const reqRows = requirements.map((r) => ({
    type: 'requirement' as const,
    id: r.id,
    name: r.name,
    code: r.code,
    status: r.status,
    scope: r.scope,
    required: r.required,
    dueDate: r.dueDate,
    phaseCode: r.phaseCode,
    owner: r.owner?.name ?? '',
    fileCount: r._count.files,
  }))
  const items = [...latestFiles, ...reqRows].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  // 分页（合并后切片）
  const total = items.length
  const paged = items.slice((page - 1) * pageSize, page * pageSize)

  // 目录权限摘要（工具栏按钮驱动）：根级用项目 perms 近似
  const perms = folderId
    ? await permsOf(user.userId, { type: 'FILE_FOLDER', id: folderId })
    : await permsOf(user.userId, { type: 'PROJECT', id: projectId })
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { isArchived: true, name: true },
  })

  return ok({
    folder: folder
      ? { id: folder.id, name: folder.name, kind: folder.kind, breadcrumb: await breadcrumb(folder) }
      : null,
    project: { id: projectId, name: project?.name ?? '', isArchived: project?.isArchived ?? false },
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      order: f.order,
      remark: f.remark,
      requirementCount: f._count.requirements,
      childrenCount: f._count.children,
    })),
    items: paged,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    perms: {
      canUpload: perms.upload,
      canEdit: perms.edit,
      canDelete: perms.delete,
      canDownload: perms.download,
    },
    isSystemFolder: folder?.kind === 'SYSTEM',
  })
})
