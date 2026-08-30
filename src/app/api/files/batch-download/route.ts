/**
 * GET /api/files/batch-download?ids=id1,id2,... —— 网盘化（20260830-drive-war W2，spec §5）
 *
 * 批量打包下载：服务端 zip 流式返回（archiver 边读边写，内存友好）。
 *  - 单批上限 100 文件；ids 去重
 *  - 权限：逐文件 download 终审（自由文件=文件夹级；条目文件=FILE_REQ 范围终审；ADMIN 直通）
 *  - 软删/不存在/无权限的文件跳过（部分成功语义，zip 内缺即提示）
 *  - 同名文件自动加后缀（folder 名/序号）避免 zip 内覆盖
 *  - 审计：逐文件 FileAccessLog(DOWNLOAD)
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, ApiError, handleApiError } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import { resolveStoredFile } from '@/lib/file-storage'
import { createZipStream } from '@/lib/zip'
import { createReadStream } from 'fs'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    return await handleBatchDownload(request)
  } catch (e) {
    return handleApiError(e)
  }
}

async function handleBatchDownload(request: NextRequest): Promise<Response> {
  const user = requireAuth(request)
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) throw ApiError.badRequest('缺少 ids 参数')
  if (ids.length > 100) throw ApiError.badRequest('单批最多 100 个文件')

  const files = await prisma.file.findMany({
    where: { id: { in: Array.from(new Set(ids)) }, deletedAt: null },
    select: {
      id: true, name: true, originalName: true, storagePath: true, mimeType: true,
      requirementId: true, folderId: true, projectId: true, version: true,
    },
  })

  // 逐文件权限终审 + 磁盘存在性
  const allowed: typeof files = []
  for (const f of files) {
    try {
      if (f.requirementId) {
        await requireCan(user.userId, 'download', { type: 'FILE_REQ', id: f.requirementId })
      } else if (f.folderId) {
        await requireCan(user.userId, 'download', { type: 'FILE_FOLDER', id: f.folderId })
      } else {
        await requireCan(user.userId, 'download', { type: 'PROJECT', id: f.projectId })
      }
      allowed.push(f)
    } catch {
      // 无权限：跳过（部分成功语义）
    }
  }
  if (allowed.length === 0) throw ApiError.forbidden('没有可下载的文件（不存在或无权限）')

  const zip = createZipStream(3)
  const used = new Map<string, number>()
  let appended = 0

  for (const f of allowed) {
    const abs = resolveStoredFile(f.storagePath)
    if (!abs) continue
    // 同名去重：name (2).ext
    let entry = f.originalName
    const n = used.get(f.originalName) ?? 0
    if (n > 0) {
      const dot = f.originalName.lastIndexOf('.')
      entry = dot > 0
        ? `${f.originalName.slice(0, dot)} (${n + 1})${f.originalName.slice(dot)}`
        : `${f.originalName} (${n + 1})`
    }
    used.set(f.originalName, n + 1)
    try {
      zip.append(createReadStream(abs), { name: entry })
      appended++
      await prisma.fileAccessLog.create({
        data: { fileId: f.id, userId: user.userId, action: 'DOWNLOAD' },
      })
    } catch {
      // 单文件读失败跳过
    }
  }
  if (appended === 0) throw ApiError.internal('文件读取失败（磁盘文件缺失）')

  const stamp = new Date().toISOString().slice(0, 10)
  const stream = new ReadableStream({
    start(controller) {
      zip.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      zip.on('end', () => controller.close())
      zip.on('error', (err: Error) => controller.error(err))
      void zip.finalize()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`文件打包下载-${stamp}.zip`)}`,
    },
  })
}
