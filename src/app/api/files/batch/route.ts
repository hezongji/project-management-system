/**
 * POST /api/files/batch —— 网盘化（20260830-drive-war W2，spec §5）
 *
 * 批量回收站操作：{ fileIds?: string[], folderIds?: string[], action }
 *   action=delete  软删（文件：删除者本人或文件夹 delete；目录：文件夹 delete=MANAGER+）
 *   action=restore 恢复（删除者本人或 MANAGER+；目录要求祖先全部存活）
 *   action=purge   彻底删除（仅 MANAGER+/ADMIN；文件物理删+磁盘清理；目录整树物理删）
 *
 * 审计：FileAccessLog(DELETE/RESTORE/PURGE) + ActivityLog；权限缓存失效。
 * 回收站保留期到期由 scripts/drive-purge-recycle.ts cron 兜底清除。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidateProject } from '@/lib/permission'
import { getLiveFolderById, softDeleteFile, restoreFile, purgeFile, softDeleteTree, restoreTree, purgeTree, isManagerPlus } from '@/lib/drive'

export const dynamic = 'force-dynamic'

const schema = z.object({
  fileIds: z.array(z.string().trim().min(1)).max(100).optional(),
  folderIds: z.array(z.string().trim().min(1)).max(50).optional(),
  action: z.enum(['delete', 'restore', 'purge']),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const body = schema.parse(await request.json())
  const fileIds = body.fileIds ?? []
  const folderIds = body.folderIds ?? []
  if (fileIds.length === 0 && folderIds.length === 0) {
    throw ApiError.badRequest('fileIds 与 folderIds 不能同时为空')
  }

  let restored = 0
  let deleted = 0
  let purged = 0
  const errors: { id: string; reason: string }[] = []
  const touchedProjects = new Set<string>()

  // ── 文件处理 ──
  for (const fid of fileIds) {
    const file = await prisma.file.findUnique({
      where: { id: fid },
      select: {
        id: true, projectId: true, folderId: true, requirementId: true, originalName: true,
        deletedAt: true, deletedById: true, uploadedById: true, storagePath: true,
        project: { select: { isArchived: true } },
      },
    })
    if (!file) { errors.push({ id: fid, reason: '文件不存在' }); continue }
    touchedProjects.add(file.projectId)

    try {
      if (body.action === 'delete') {
        if (file.deletedAt) { errors.push({ id: fid, reason: '已在回收站' }); continue }
        if (file.project.isArchived) throw ApiError.badRequest('项目已归档')
        // 权限：上传人本人 或 文件夹 delete（MANAGER+；条目文件沿用条目审核人/ADMIN 规则由 delete 单条端点负责，批量软删从严）
        const self = file.uploadedById === user.userId
        if (!self) {
          if (file.folderId) {
            await requireCan(user.userId, 'delete', { type: 'FILE_FOLDER', id: file.folderId })
          } else {
            await requireCan(user.userId, 'delete', { type: 'PROJECT', id: file.projectId })
          }
        }
        await softDeleteFile(file, user.userId)
        deleted++ // 家族计数在 message 层以项计，行数见审计
      } else if (body.action === 'restore') {
        if (!file.deletedAt) { errors.push({ id: fid, reason: '不在回收站' }); continue }
        const self = file.deletedById === user.userId || file.uploadedById === user.userId
        if (!self) {
          const mp = await isManagerPlus(user.userId, file.projectId)
          if (!mp) throw ApiError.forbidden('仅删除者本人或管理者可恢复')
        }
        const n = await restoreFile(file, user.userId)
        restored += n
      } else {
        // purge：仅 MANAGER+
        if (!file.deletedAt) { errors.push({ id: fid, reason: '仅回收站文件可彻底删除' }); continue }
        const mp = await isManagerPlus(user.userId, file.projectId)
        if (!mp) throw ApiError.forbidden('彻底删除仅项目经理及以上可执行')
        await purgeFile(file, user.userId)
        purged++
      }
    } catch (e) {
      errors.push({ id: fid, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── 目录处理 ──
  for (const cid of folderIds) {
    const folder = await prisma.fileCatalog.findUnique({
      where: { id: cid },
      select: { id: true, projectId: true, name: true, kind: true, path: true, deletedAt: true, deletedById: true },
    })
    if (!folder) { errors.push({ id: cid, reason: '目录不存在' }); continue }
    if (folder.kind === 'SYSTEM') { errors.push({ id: cid, reason: '系统目录受保护' }); continue }
    touchedProjects.add(folder.projectId)

    try {
      if (body.action === 'delete') {
        if (folder.deletedAt) { errors.push({ id: cid, reason: '已在回收站' }); continue }
        await requireCan(user.userId, 'delete', { type: 'FILE_FOLDER', id: folder.id })
        const r = await softDeleteTree(folder, user.userId)
        deleted += r.folders + r.files
      } else if (body.action === 'restore') {
        if (!folder.deletedAt) { errors.push({ id: cid, reason: '不在回收站' }); continue }
        const self = folder.deletedById === user.userId
        if (!self) {
          const mp = await isManagerPlus(user.userId, folder.projectId)
          if (!mp) throw ApiError.forbidden('仅删除者本人或管理者可恢复')
        }
        const r = await restoreTree(folder)
        restored += r.folders + r.files
      } else {
        if (!folder.deletedAt) { errors.push({ id: cid, reason: '仅回收站目录可彻底删除' }); continue }
        const mp = await isManagerPlus(user.userId, folder.projectId)
        if (!mp) throw ApiError.forbidden('彻底删除仅项目经理及以上可执行')
        const r = await purgeTree(folder, user.userId)
        purged += r.folders + r.files
      }
    } catch (e) {
      errors.push({ id: cid, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  // 审计汇总 + 缓存失效
  for (const pid of Array.from(touchedProjects)) {
    invalidateProject(pid)
    await prisma.activityLog.create({
      data: {
        projectId: pid,
        userId: user.userId,
        action: `drive.batch.${body.action}`,
        detail: { fileIds, folderIds, deleted, restored, purged, errors: errors.length } as Prisma.InputJsonValue,
      },
    })
  }

  const msg =
    body.action === 'delete' ? `已移入回收站 ${deleted} 项`
    : body.action === 'restore' ? `已恢复 ${restored} 项`
    : `已彻底删除 ${purged} 项`
  return ok({ deleted, restored, purged, errors }, errors.length > 0 ? `${msg}（${errors.length} 项失败，详见 errors）` : msg)
})
