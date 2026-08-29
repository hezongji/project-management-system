/**
 * 文件访问共享逻辑 —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * 下载（download）与预览（preview）共用的加载/鉴权/留痕/流式返回链路：
 *   1. 加载 File（含 requirementId/projectId/storagePath）
 *   2. 权限：
 *      - 条目文件（requirementId 非空）→ FILE_REQ 的 download/view
 *        （范围终审 PUBLIC/RESTRICTED/PRIVATE 生效，§6.1 第 4 步）
 *      - 计划外文件（requirementId=null）→ 回退项目 view（任意项目成员可见，
 *        工程决策见 P2-2 报告：计划外文件无条目范围，按项目共享语义放行）
 *   3. resolveStoredFile 解析落盘路径（防越界）
 *   4. 写 FileAccessLog(VIEW/DOWNLOAD)（§5 FileAccessLog 留痕）
 *   5. streamFile 流式返回（含 HTTP Range 206 支持）
 */

import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { ApiError } from './api-helpers'
import { requireCan } from './permission'
import { isChatArchiveProject } from './chat-archive'
import { resolveStoredFile, streamFile } from './file-storage'

export type FileAccessAction = 'VIEW' | 'DOWNLOAD'

export async function accessFile(
  request: NextRequest,
  fileId: string,
  action: FileAccessAction,
  userId: string,
): Promise<Response> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      requirementId: true,
      projectId: true,
      name: true,
      originalName: true,
      mimeType: true,
      storagePath: true,
    },
  })
  if (!file) throw ApiError.notFound('文件不存在')

  // 条目文件走 FILE_REQ 范围终审；计划外文件回退项目 view（见文件头）
  // 聊天记录项目（内部共享文件池）：登录即可读
  if (file.requirementId) {
    const permAction = action === 'DOWNLOAD' ? 'download' : 'view'
    await requireCan(userId, permAction, { type: 'FILE_REQ', id: file.requirementId })
  } else if (!(await isChatArchiveProject(file.projectId))) {
    await requireCan(userId, 'view', { type: 'PROJECT', id: file.projectId })
  }

  const abs = resolveStoredFile(file.storagePath)
  if (!abs) throw ApiError.notFound('文件存储路径非法')

  // 留痕（§5 FileAccessLog）
  await prisma.fileAccessLog.create({
    data: { fileId: file.id, userId, action },
  })

  const range = request.headers.get('range')
  return streamFile(abs, {
    mimeType: file.mimeType,
    filename: file.originalName || file.name,
    inline: action === 'VIEW',
    range,
  })
}
