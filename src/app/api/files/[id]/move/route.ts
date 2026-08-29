/**
 * PATCH /api/files/:id/move —— PC 端文件移动（IM App v1.1 战役 W4，2026-08-29）
 *
 * 仅允许**计划外文件**（requirementId=null）在**项目内**移动目录：
 *   - 条目文件（挂交付计划条目）禁止移动：移动会与 requirement.catalogId 矛盾、
 *     绕过条目审核语义 → 400
 *   - 跨项目移动禁止：storagePath 与 DB projectId 脱钩会致配额/可见性/归档判定
 *     全失真 → 400
 *
 * 实现（原子性 + 回滚）：
 *   1. fs.rename 物理迁移（FILE_ROOT 单卷同盘，同目录 rename 原子）
 *   2. DB updateMany({ where: { id, storagePath: 旧 }, data: { storagePath: 新 } })
 *      判 count===1 防并发双移动；失败则 rename 回去
 *   3. FileAccessLog 写 MOVE（审计留痕）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { resolveStoredFile } from '@/lib/file-storage'
import { requireCan } from '@/lib/permission'
import { promises as fsp } from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const PATCH = apiHandler(async (request: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const user = requireAuth(request)

  const body = (await request.json().catch(() => ({}))) as { catalogId?: string }
  const catalogId = String(body.catalogId ?? '').trim()
  if (!catalogId) throw ApiError.badRequest('缺少 catalogId（移动目标目录）')

  const file = await prisma.file.findUnique({
    where: { id },
    select: {
      id: true,
      requirementId: true,
      projectId: true,
      name: true,
      originalName: true,
      storagePath: true,
      project: { select: { isArchived: true } },
    },
  })
  if (!file) throw ApiError.notFound('文件不存在')

  // 归档冻结（对齐 delete/upload 口径）
  if (file.project.isArchived) {
    throw ApiError.badRequest('项目已归档，禁止移动文件；如需调整请先解除归档')
  }

  // 条目文件禁止移动（交付计划管理）
  if (file.requirementId) {
    throw ApiError.badRequest('条目文件不可移动（受交付计划管理）')
  }

  // 目标目录必须存在且属于同一项目（跨项目禁止）
  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: catalogId },
    select: { id: true, projectId: true },
  })
  if (!catalog) throw ApiError.notFound('目标目录不存在')
  if (catalog.projectId !== file.projectId) {
    throw ApiError.badRequest('仅支持项目内移动')
  }

  // 权限：与上传同级（upload），非 view；ADMIN 经 requireCan 内部放行
  await requireCan(user.userId, 'upload', { type: 'PROJECT', id: file.projectId })

  // 新 storagePath：把 {projectId}/{旧catalogId}/{uuid}.{ext} 中目录段替换
  const oldStoragePath = file.storagePath
  const segs = oldStoragePath.split('/')
  if (segs.length < 3) {
    throw ApiError.badRequest('文件路径异常，无法移动')
  }
  segs[1] = catalogId
  const newStoragePath = segs.join('/')

  const oldAbs = resolveStoredFile(oldStoragePath)
  const newAbs = resolveStoredFile(newStoragePath)
  if (!oldAbs || !newAbs) {
    throw ApiError.badRequest('文件路径越界，无法移动')
  }

  let renamed = false
  try {
    // 确保目标目录存在（目录树里该 catalog 可能存在但磁盘目录未建）
    await fsp.mkdir(path.dirname(newAbs), { recursive: true })
    await fsp.rename(oldAbs, newAbs)
    renamed = true

    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.file.updateMany({
        where: { id, storagePath: oldStoragePath },
        data: { storagePath: newStoragePath },
      })
      if (res.count !== 1) {
        throw new Error('CONCURRENT_MOVE')
      }
      await tx.fileAccessLog.create({
        data: { fileId: id, userId: user.userId, action: 'MOVE' },
      })
      return tx.file.findUnique({ where: { id } })
    })

    return ok(
      {
        file: {
          id: updated?.id,
          name: updated?.name,
          originalName: updated?.originalName,
          size: updated?.size,
          mimeType: updated?.mimeType,
          storagePath: updated?.storagePath,
          projectId: updated?.projectId,
        },
      },
      '文件已移动',
    )
  } catch (e) {
    // 回滚：rename 已执行但 DB 未提交（或并发冲突）→ 物理文件移回
    if (renamed) {
      try {
        await fsp.rename(newAbs, oldAbs)
      } catch (rollbackErr) {
        // 回滚失败：文件可能滞留目标目录，必须人工处理
        console.error(
          `CRITICAL [file-move] 回滚失败 fileId=${id} old=${oldAbs} new=${newAbs}`,
          rollbackErr,
        )
      }
    }
    if (e instanceof Error && e.message === 'CONCURRENT_MOVE') {
      throw new ApiError(409, '文件已被其他操作移动，请刷新后重试', 'CONFLICT')
    }
    throw e
  }
})
