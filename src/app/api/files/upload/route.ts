/**
 * POST /api/files/upload —— 依据《开发文档-项目管理系统重构》§7.7 + 网盘化（20260830-drive-war W2）
 *
 * 项目 upload 权限，计划外临时文件（挂目录、不挂条目 requirementId=null）。
 * multipart(file + folderId|catalogId) → 新 File 记录（requirementId=null，version=1）。
 *
 * 网盘化扩展：
 *  - 入参 folderId（与 catalogId 等价同源，folderId 优先）
 *  - SYSTEM 目录（交付计划区）自由上传仅 MANAGER+/ADMIN（条目流程上传走 submit，不受影响）
 *  - 同目录同名活跃文件 → 新版本（version+1，spec D4），避免 Windows 式副本污染
 *  - File 行写入 folderId（逻辑目录权威列，storagePath 物理路径解耦）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { isChatArchiveProject } from '@/lib/chat-archive'
import { getLiveFolder, assertFolderUsableAsTarget, latestActiveVersion } from '@/lib/drive'
import {
  fileConfig,
  isAllowedMime,
  sha256,
  writeUploadFile,
  projectUsedBytes,
} from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const formData = await request.formData()
  const uploaded = formData.get('file')
  const isFileLike =
    uploaded !== null &&
    typeof uploaded === 'object' &&
    typeof (uploaded as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    typeof (uploaded as { name?: unknown }).name === 'string'
  if (!isFileLike) {
    throw ApiError.badRequest('缺少 multipart 字段 file')
  }
  // 网盘化：folderId 优先，兼容旧 catalogId 入参（IM App 等存量客户端）
  const folderId = String(formData.get('folderId') ?? formData.get('catalogId') ?? '').trim()
  if (!folderId) {
    throw ApiError.badRequest('缺少 folderId（网盘文件需挂载到某个目录）')
  }

  const catalog = await getLiveFolder(folderId)

  // 聊天记录项目（内部共享文件池）：登录即可传，不受项目成员约束
  const isArchive = await isChatArchiveProject(catalog.projectId)
  if (!isArchive) {
    // 网盘化：文件夹级 upload（MEMBER/MANAGER 基线含 upload；VIEWER 只读；ACL 可追加）
    await requireCan(user.userId, 'upload', { type: 'FILE_FOLDER', id: catalog.id })
    // SYSTEM 目录（交付计划区）自由上传仅 MANAGER+（应急通道）；条目流程上传走 submit 不受影响
    if (catalog.kind === 'SYSTEM') {
      await assertFolderUsableAsTarget(user.userId, catalog)
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: catalog.projectId },
    select: { isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw ApiError.forbidden('项目已归档，禁止上传')

  const fileObj = uploaded as File
  const originalName = fileObj.name || '未命名文件'
  const mimeType = fileObj.type || 'application/octet-stream'
  const buffer = Buffer.from(await fileObj.arrayBuffer())

  const cfg = fileConfig()
  if (buffer.byteLength === 0) throw ApiError.badRequest('文件内容为空')
  if (buffer.byteLength > cfg.maxSize) {
    throw ApiError.badRequest(
      `文件大小 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过单文件上限 ${(cfg.maxSize / 1024 / 1024).toFixed(0)}MB`,
    )
  }
  if (!isAllowedMime(mimeType)) {
    throw ApiError.badRequest(`不允许的文件类型：${mimeType}`)
  }
  const used = await projectUsedBytes(catalog.projectId)
  if (!isArchive && used + buffer.byteLength > cfg.quotaPerProject) {
    throw ApiError.badRequest(
      `项目配额已满（已用 ${(used / 1024 / 1024 / 1024).toFixed(2)}GB / ${(cfg.quotaPerProject / 1024 / 1024 / 1024).toFixed(0)}GB）`,
    )
  }

  const checksum = sha256(buffer)

  // 同目录同名活跃自由文件 → 新版本（spec D4）
  const existing = await latestActiveVersion(catalog.id, originalName)
  const nextVersion = (existing?.version ?? 0) + 1

  let absolutePath: string | null = null
  try {
    const written = await writeUploadFile(
      catalog.projectId,
      catalog.id,
      originalName,
      mimeType,
      buffer,
    )
    absolutePath = written.absolutePath

    const file = await prisma.file.create({
      data: {
        requirementId: null,
        projectId: catalog.projectId,
        folderId: catalog.id, // ★ 网盘化：逻辑目录权威列
        name: originalName,
        originalName,
        storagePath: written.storagePath,
        size: buffer.byteLength,
        mimeType,
        checksum,
        version: nextVersion,
        uploadedById: user.userId,
      },
    })

    await prisma.fileAccessLog.create({
      data: { fileId: file.id, userId: user.userId, action: 'UPLOAD' },
    })

    return ok(
      {
        file: {
          id: file.id,
          name: file.name,
          originalName: file.originalName,
          size: file.size,
          mimeType: file.mimeType,
          checksum: file.checksum,
          version: file.version,
          folderId: file.folderId,
          createdAt: file.createdAt,
        },
      },
      nextVersion > 1 ? `同名文件已合并为新版本 v${nextVersion}` : '文件上传成功',
      201,
    )
  } catch (e) {
    if (absolutePath) {
      const { unlink } = await import('fs/promises')
      await unlink(absolutePath).catch(() => {})
    }
    throw e
  }
})
