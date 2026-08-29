/**
 * /api/file-requirements/mine —— 我的待提交文件（2026-08-21 个人交付物）
 *
 * GET 登录  跨项目查询当前用户需提交的交付物：
 *   - ownerId = 我
 *   - 状态 ∈ { WAITING, REVIEWING, REJECTED }（未完成）
 *   - 附项目名/阶段/目录/截止日期/是否逾期/已传文件数
 * 工作台「我的待提交文件」卡片用。
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  // 上限 200：成员交付物可能很多（如孙若清 119 个），避免新分配条目被截断
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '10', 10) || 10))
  const skip = (page - 1) * limit

  const now = new Date()
  // 非终态均返回（WAITING 待提交 / SUBMITTED 已提交待审 / REVIEWING 审核中 / REJECTED 需修订），
  // 前端按状态分组展示（2026-08-21 多状态视图）
  const NON_FINAL = ['WAITING', 'SUBMITTED', 'REVIEWING', 'REJECTED'] as const
  const [items, total] = await Promise.all([
    prisma.fileRequirement.findMany({
      where: {
        ownerId: user.userId,
        status: { in: [...NON_FINAL] },
      },
      select: {
        id: true,
        name: true,
        code: true,
        phaseCode: true,
        dueDate: true,
        status: true,
        remark: true,
        project: { select: { id: true, code: true, name: true, status: true } },
        catalog: { select: { name: true } },
        _count: { select: { files: true } },
      },
      // 排序（2026-08-21 修复）：无截止日期（新分配，nulls first）优先，
      // 有截止日期的按截止时间升序（逾期/紧迫靠前），同因再按创建时间新者靠前
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.fileRequirement.count({
      where: {
        ownerId: user.userId,
        status: { in: [...NON_FINAL] },
      },
    }),
  ])

  return ok({
    items: items.map((r) => ({
      ...r,
      overdue: !!(r.dueDate && r.dueDate < now),
    })),
    // 状态分组统计（工作台多状态徽章）
    stats: {
      waiting: items.filter((r) => r.status === 'WAITING').length,
      submitted: items.filter((r) => r.status === 'SUBMITTED' || r.status === 'REVIEWING').length,
      rejected: items.filter((r) => r.status === 'REJECTED').length,
      overdue: items.filter(
        (r) => (r.status === 'WAITING' || r.status === 'REJECTED') && r.dueDate && r.dueDate < now,
      ).length,
    },
    pagination: { page, limit, total },
  })
})
