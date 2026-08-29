import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveUserPages } from '@/lib/page-permissions'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'

/**
 * GET /api/auth/me → 当前用户
 * §7.1 微调：含 department/jobTitle（schema v1.1 用户字段）
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      phone: true,
      avatar: true,
      departmentId: true,
      jobTitle: true,
      duties: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      pagePermissions: true,
      extraVisibleProjectIds: true,
      department: {
        select: { id: true, name: true },
      },
    },
  })

  if (!user) {
    throw ApiError.notFound('用户不存在')
  }

  if (!user.isActive) {
    throw new ApiError(401, '账户已被禁用')
  }

  const { pagePermissions, extraVisibleProjectIds, ...rest } = user
  return ok({
    ...rest,
    // 权限 V2：最终可见页面集
    pages: resolveUserPages(user.role, pagePermissions as string[] | null),
    extraVisibleProjectIds,
  })
})
