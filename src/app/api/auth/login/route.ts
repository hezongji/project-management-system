import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { resolveUserPages } from '@/lib/page-permissions'
import { signAuthToken } from '@/lib/auth'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { isLoginLocked, recordLoginFail, clearLoginFails, getClientIp } from '@/lib/rate-limit'
import { z } from 'zod'

const loginSchema = z.object({
  email: z.string().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
})

/** POST /api/auth/login → { user, token }（§7.1，登录接口沿用现有）
 *  账号支持三种：邮箱 / 用户名 / 姓名（组织架构人员名，如「陈牧之」） */
export const POST = apiHandler(async (request: NextRequest) => {
  const body = await request.json()
  const validatedData = loginSchema.parse(body)
  const account = validatedData.email.trim()
  const ip = getClientIp(request)

  // 速率限制（2026-08-22 P1-3 修复）：5 次失败锁 15 分钟，防暴力破解/撞库
  const lock = isLoginLocked(account, ip)
  if (lock.locked) {
    throw new ApiError(429, `尝试次数过多，请 ${lock.retryAfterSec ?? 15 * 60} 秒后重试`)
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: account }, { username: account }, { name: account }],
    },
  })

  if (!user || !user.password) {
    recordLoginFail(account, ip)
    throw new ApiError(401, '邮箱或密码错误')
  }

  const isPasswordValid = await bcrypt.compare(validatedData.password, user.password)
  if (!isPasswordValid) {
    recordLoginFail(account, ip)
    throw new ApiError(401, '邮箱或密码错误')
  }

  if (!user.isActive) {
    throw new ApiError(401, '账户已被禁用')
  }

  // 登录成功：清除该账号+IP 的失败计数
  clearLoginFails(account, ip)

  // 更新最后登录时间（schema v1.1 字段：lastLoginAt）
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  // 生成带签名的 JWT token
  const token = signAuthToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  })

  const userResponse = {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    role: user.role,
    avatar: user.avatar,
    departmentId: user.departmentId,
    jobTitle: user.jobTitle,
    isActive: user.isActive,
    createdAt: user.createdAt,
    // 权限 V2：最终可见页面集（管理员分配，null 时按角色默认）
    pages: resolveUserPages(user.role, user.pagePermissions as string[] | null),
    extraVisibleProjectIds: user.extraVisibleProjectIds,
  }

  return ok({ user: userResponse, token }, '登录成功')
})
