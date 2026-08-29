/**
 * 管理端鉴权辅助 —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * 与 requireRole(user, 'ADMIN') 的区别：requireRole 只信任 JWT 里的 role，
 * 而 JWT 是登录时签发的快照，角色被降级/停用后仍可能在 30 天有效期内。
 * requireAdmin 每次以 DB 中的实时角色 + isActive 为准，杜绝「降级后仍可管理」的越权窗口。
 */

import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { requireAuth, ApiError } from './api-helpers'
import type { AuthUser } from './auth'

/** 管理端专用鉴权：未认证 → 401；非 ADMIN / 已停用 → 403 */
export async function requireAdmin(request: NextRequest): Promise<AuthUser> {
  const user = requireAuth(request)
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { role: true, isActive: true },
  })
  if (!dbUser || !dbUser.isActive || dbUser.role !== 'ADMIN') {
    throw ApiError.forbidden('需要 ADMIN 权限')
  }
  return user
}
