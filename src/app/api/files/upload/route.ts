/**
 * POST /api/files/upload —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * 项目 upload 权限，计划外临时文件（挂目录 catalogId、不挂条目 requirementId=null）。
 * multipart(file + catalogId) → 新 File 记录（requirementId=null，version=1）。
 *
 * 与 submit 的区别：不递增版本、不改条目状态、不通知 reviewer，
 * 仅校验大小/配额/mimeType/sha256 后落盘并写 FileAccessLog(UPLOAD)。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { isChatArchiveProject } from '@/lib/chat-archive'
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
  const catalogId = String(formData.get('catalogId') ?? '').trim()
  if (!catalogId) {
    throw ApiError.badRequest('缺少 catalogId（计划外文件需挂载到某个目录）')
  }

  const catalog = await prisma.fileCatalog.findUnique({
    where: { id: catalogId },
    select: { id: true, projectId: true },
  })
  if (!catalog) throw ApiError.notFound('目录不存在')

  // 聊天记录项目（内部共享文件池）：登录即可传，不受项目成员约束
  const isArchive = await isChatArchiveProject(catalog.projectId)
  if (!isArchive) {
    await requireCan(user.userId, 'upload', { type: 'PROJECT', id: catalog.projectId })
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
        name: originalName,
        originalName,
        storagePath: written.storagePath,
        size: buffer.byteLength,
        mimeType,
        checksum,
        version: 1,
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
          createdAt: file.createdAt,
        },
      },
      '计划外文件上传成功',
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
