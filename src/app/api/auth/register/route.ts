import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { signAuthToken } from '@/lib/auth'
import { apiHandler, created, ApiError } from '@/lib/api-helpers'
import { loadSettings } from '@/lib/system-settings'
import { z } from 'zod'

const registerSchema = z.object({
  name: z.string().min(2, '姓名至少需要2个字符'),
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(8, '密码至少需要8个字符'),
})

/** POST /api/auth/register → { user, token }（§7.1，评估期开放） */
export const POST = apiHandler(async (request: NextRequest) => {
  const body = await request.json()
  const validatedData = registerSchema.parse(body)

  // 注册开关（§7.10）：复用 loadSettings 统一口径，registerEnabled === false 时拒绝注册
  const settings = await loadSettings()
  if (settings.registerEnabled === false) {
    throw ApiError.forbidden('注册已关闭，请联系管理员')
  }

  // 检查邮箱是否已存在
  const existingUser = await prisma.user.findUnique({
    where: { email: validatedData.email },
  })
  if (existingUser) {
    throw ApiError.badRequest('该邮箱已被注册')
  }

  // 检查用户名是否已存在
  const username = validatedData.email.split('@')[0] + Math.floor(Math.random() * 1000)
  const existingUsername = await prisma.user.findUnique({
    where: { username },
  })
  if (existingUsername) {
    throw ApiError.badRequest('用户名已存在，请稍后重试')
  }

  // 加密密码
  const hashedPassword = await bcrypt.hash(validatedData.password, 12)

  // 创建用户（schema v1.1：role 默认 MEMBER，无需显式指定）
  const user = await prisma.user.create({
    data: {
      email: validatedData.email,
      username,
      password: hashedPassword,
      name: validatedData.name,
      isActive: true,
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  })

  // 生成带签名的 JWT token
  const token = signAuthToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  })

  return created({ user, token }, '注册成功')
})
