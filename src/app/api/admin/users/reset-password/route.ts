/**
 * /api/admin/users/reset-password —— 管理员重置用户密码（P1-5 兜底方案）
 *
 * POST  ADMIN  { userId, newPassword }
 *   - ADMIN 权限（实时 DB 角色校验，同 requireAdmin）
 *   - bcrypt cost=12（与 register/login 一致）
 *   - 返回目标用户简要信息；不返回密码
 */

import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

const resetPasswordSchema = z.object({
  userId: z.string().min(1, 'userId 不能为空'),
  newPassword: z.string().min(8, '新密码至少需要8个字符'),
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const body = resetPasswordSchema.parse(await request.json())

  const target = await prisma.user.findUnique({ where: { id: body.userId } })
  if (!target) throw ApiError.notFound('用户不存在')

  const hashedPassword = await bcrypt.hash(body.newPassword, 12)

  await prisma.user.update({
    where: { id: body.userId },
    data: { password: hashedPassword },
  })

  return ok(
    {
      id: target.id,
      email: target.email,
      username: target.username,
      name: target.name,
    },
    '密码已重置'
  )
})
