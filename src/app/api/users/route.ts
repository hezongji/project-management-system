/**
 * /api/users —— IM @提及 联想数据源（依据开发文档 §8.2⑥ / §9.2 mentions）
 *
 * GET：在职用户摘要（id/name/email/avatar），供输入框 @ 联想与 mentions 上送映射。
 * 仅登录可访问；按姓名排序，最多 200 条（覆盖中小团队）。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  requireAuth(request)

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, email: true, avatar: true },
    orderBy: { name: 'asc' },
    take: 200,
  })

  return ok(users)
})
