/**
 * POST /api/im/upload-target —— 聊天附件自动归档目标（v1.2 owner 定案）
 *
 * 规则：
 *   - 项目群（会话 projectId 非空）→ 该项目默认目录（无目录则建「默认文件夹」）
 *   - 普通单聊/群聊（projectId 空）→ 系统「聊天记录」项目默认目录（不再强制选项目）
 *
 * body: { conversationId }
 * 返回: { projectId, projectName, catalogId, catalogName }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

const CHAT_ARCHIVE_CODE = 'CHAT_ARCHIVE'

async function ensureCatalog(tx: any, projectId: string, name: string) {
  const existing = await tx.fileCatalog.findFirst({
    where: { projectId },
    orderBy: { order: 'asc' },
  })
  if (existing) return existing
  return tx.fileCatalog.create({
    data: { projectId, name, order: 0 },
  })
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const body = await request.json().catch(() => ({}))
  const conversationId = String(body.conversationId ?? '').trim()
  if (!conversationId) throw ApiError.badRequest('缺少 conversationId')

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, projectId: true, type: true },
  })
  if (!conv) throw ApiError.badRequest('会话不存在')

  // 校验当前用户是会话成员（防越权获取项目目录）
  const isMember = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.userId } },
    select: { userId: true },
  })
  if (!isMember) throw ApiError.forbidden('不是该会话成员')

  let projectId = conv.projectId
  let projectName = '聊天记录'

  if (projectId) {
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })
    projectName = proj?.name ?? '项目'
  } else {
    // 普通聊天 → 系统「聊天记录」项目（无则建）
    let archive = await prisma.project.findUnique({ where: { code: CHAT_ARCHIVE_CODE }, select: { id: true, name: true } })
    if (!archive) {
      archive = await prisma.project.create({
        data: {
          code: CHAT_ARCHIVE_CODE,
          name: '聊天记录',
          createdBy: user.userId,
          status: 'ACTIVE',
        },
        select: { id: true, name: true },
      })
    }
    projectId = archive.id
    projectName = archive.name
  }

  const catalog = await ensureCatalog(prisma, projectId, '默认文件夹')

  return ok({
    projectId,
    projectName,
    catalogId: catalog.id,
    catalogName: catalog.name,
  })
})
