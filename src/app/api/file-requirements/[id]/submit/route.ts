/**
 * POST /api/file-requirements/:id/submit —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * 上传人权限（requireCan 'upload' on FILE_REQ）。multipart(file) → 新 File 记录
 * version+1、status=SUBMITTED、通知 reviewer（Notification + im_events notify:push）。
 * 校验：大小配额、mimeType、sha256 checksum（§7.7）。
 *
 * 流程：
 *   1. 鉴权 + requireCan(userId, 'upload', {type:'FILE_REQ', id})
 *   2. 解析 multipart 的 file 字段（单文件）
 *   3. 校验：文件存在 / 大小≤FILE_MAX_SIZE / 项目配额 / mimeType 合法 / 项目未归档
 *   4. 计算 sha256、扩展名、写盘 {FILE_ROOT}/{projectId}/{catalogId}/{uuid}.{ext}
 *   5. 事务内：version = max(files.version)+1（默认1）→ 建 File + FileAccessLog(UPLOAD)
 *      + 条目 status=SUBMITTED + reviewer 通知（Notification + pg_notify notify:push）
 *   6. 写盘失败/事务失败 → 清理落盘文件，保证不产生孤儿文件
 *
 * reviewer 解析（§7.7「审核人默认阶段负责人」+ phase-engine P1-1 工程决策）：
 *   requirement.reviewerId ?? 阶段负责人(Phase.ownerId) ?? 项目 OWNER
 *   （reviewerId 实例化时不落死值，运行时动态解析）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'
import {
  fileConfig,
  isAllowedMime,
  sha256,
  writeUploadFile,
  projectUsedBytes,
} from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const user = requireAuth(request)
  const { id } = await context.params

  await requireCan(user.userId, 'upload', { type: 'FILE_REQ', id })

  const requirement = await prisma.fileRequirement.findUnique({
    where: { id },
    select: {
      id: true,
      projectId: true,
      catalogId: true,
      name: true,
      status: true,
      dueDate: true,
    },
  })
  if (!requirement) throw ApiError.notFound('文件条目不存在')

  const project = await prisma.project.findUnique({
    where: { id: requirement.projectId },
    select: { isArchived: true, code: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw ApiError.forbidden('项目已归档，禁止上传')

  // ── 解析 multipart 单文件 ──
  const formData = await request.formData()
  const uploaded = formData.get('file')
  const isFileLike =
    uploaded !== null &&
    typeof uploaded === 'object' &&
    typeof (uploaded as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    typeof (uploaded as { name?: unknown }).name === 'string'
  if (!isFileLike) {
    throw ApiError.badRequest('缺少 multipart 字段 file（请以 multipart/form-data 上传单个文件）')
  }
  const fileObj = uploaded as File
  const originalName = fileObj.name || '未命名文件'
  const mimeType = fileObj.type || 'application/octet-stream'
  const buffer = Buffer.from(await fileObj.arrayBuffer())

  // ── 校验：大小 / 配额 / mimeType（§7.7） ──
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

  const checksum = sha256(buffer)

  // ── 写盘（事务外；事务失败则清理，见 finally） ──
  let absolutePath: string | null = null
  let storagePath = ''
  try {
    const written = await writeUploadFile(
      requirement.projectId,
      requirement.catalogId,
      originalName,
      mimeType,
      buffer,
    )
    absolutePath = written.absolutePath
    storagePath = written.storagePath

    const result = await prisma.$transaction(
      async (tx) => {
        // 配额校验（项目已用 + 本次，§3.1 FILE_QUOTA_PER_PROJECT）
        const used = await projectUsedBytes(requirement.projectId)
        if (used + buffer.byteLength > cfg.quotaPerProject) {
          throw new Error(
            `项目配额已满（已用 ${(used / 1024 / 1024 / 1024).toFixed(2)}GB / ${(cfg.quotaPerProject / 1024 / 1024 / 1024).toFixed(0)}GB）`,
          )
        }

        // version = 同条目 max(version)+1（§5 File.version 同条目内递增）
        const latest = await tx.file.findFirst({
          where: { requirementId: id },
          orderBy: { version: 'desc' },
          select: { version: true },
        })
        const version = (latest?.version ?? 0) + 1

        const file = await tx.file.create({
          data: {
            requirementId: id,
            projectId: requirement.projectId,
            name: `${requirement.name} v${version}`,
            originalName,
            storagePath,
            size: buffer.byteLength,
            mimeType,
            checksum,
            version,
            uploadedById: user.userId,
          },
        })

        await tx.fileAccessLog.create({
          data: { fileId: file.id, userId: user.userId, action: 'UPLOAD' },
        })

        await tx.fileRequirement.update({
          where: { id },
          data: { status: 'SUBMITTED' },
        })

        // 催办闭环（2026-08-22）：被催人提交后，相关 ACTIVE 催办置 DONE
        await tx.urgeRecord.updateMany({
          where: { requirementId: id, targetUserId: user.userId, status: 'ACTIVE' },
          data: { status: 'DONE', doneAt: new Date() },
        })

        // ── reviewer 通知并入事务（P2-1 修复：文件提交-通知原子，PG NOTIFY 事务内投递、回滚不发出） ──
        // reviewer 运行时解析（reviewerId ?? 阶段负责人 ?? 项目 OWNER，§7.7）
        const reviewerReq = await tx.fileRequirement.findUnique({
          where: { id },
          select: { reviewerId: true, phaseCode: true, projectId: true },
        })
        let reviewerId: string | null = null
        if (reviewerReq) {
          if (reviewerReq.reviewerId) reviewerId = reviewerReq.reviewerId
          else if (reviewerReq.phaseCode) {
            const phase = await tx.phase.findUnique({
              where: { projectId_code: { projectId: reviewerReq.projectId, code: reviewerReq.phaseCode } },
              select: { ownerId: true },
            })
            reviewerId = phase?.ownerId ?? null
          }
          if (!reviewerId) {
            const owner = await tx.projectMember.findFirst({
              where: { projectId: reviewerReq.projectId, role: 'OWNER' },
              select: { userId: true },
            })
            reviewerId = owner?.userId ?? null
          }
        }
        if (reviewerId) {
          await tx.notification.create({
            data: {
              userId: reviewerId,
              type: 'FILE_PENDING_REVIEW',
              title: `文件待审核：${requirement.name}`,
              body: `${requirement.name} 已提交第 v${version} 版，请审核`,
              link: `/files?projectId=${requirement.projectId}&requirementId=${id}`,
            },
          })
          // §7.9：给 reviewer 补写待办（sourceType=FILE_REQ，幂等，不重复建）
          const existingTodo = await tx.todoItem.findFirst({
            where: { userId: reviewerId, sourceType: 'FILE_REQ', sourceId: id, doneAt: null },
            select: { id: true },
          })
          if (!existingTodo) {
            await tx.todoItem.create({
              data: {
                userId: reviewerId,
                title: `待审核文件：${requirement.name}`,
                sourceType: 'FILE_REQ',
                sourceId: id,
                link: `/files?projectId=${requirement.projectId}&requirementId=${id}`,
                dueAt: requirement.dueDate,
                priority: 'HIGH',
              },
            })
          }
          await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
            event: 'notify:push',
            userId: reviewerId,
            title: `文件待审核：${requirement.name}`,
            body: `${requirement.name} 已提交第 v${version} 版，请审核`,
            link: `/files?projectId=${requirement.projectId}&requirementId=${id}`,
          })})`
        }

        return { file, version }
      },
      { timeout: 30_000 },
    )

    return ok(
      {
        file: {
          id: result.file.id,
          name: result.file.name,
          originalName: result.file.originalName,
          size: result.file.size,
          mimeType: result.file.mimeType,
          checksum: result.file.checksum,
          version: result.file.version,
          createdAt: result.file.createdAt,
        },
        requirement: { id, status: 'SUBMITTED' },
      },
      `上传成功（第 v${result.version} 版）`,
      201,
    )
  } catch (e) {
    // 事务失败/配额超限 → 清理已落盘文件，避免孤儿文件
    if (absolutePath) {
      const { unlink } = await import('fs/promises')
      await unlink(absolutePath).catch(() => {})
    }
    if (e instanceof Error && e.message.includes('配额已满')) {
      throw ApiError.badRequest(e.message)
    }
    throw e
  }
})
