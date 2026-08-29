/**
 * 聊天记录系统项目识别（v1.2）
 *
 * 「聊天记录」项目（code=CHAT_ARCHIVE）承载普通单聊/群聊的附件归档，
 * 是内部共享文件池——所有登录用户可读可传，不受项目成员/配额约束。
 */

import { prisma } from '@/lib/prisma'

export const CHAT_ARCHIVE_CODE = 'CHAT_ARCHIVE'

/** 判断 projectId 是否为「聊天记录」系统项目 */
export async function isChatArchiveProject(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { code: true },
  })
  return p?.code === CHAT_ARCHIVE_CODE
}
