/**
 * /api/admin/users/:id —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * DELETE  ADMIN  删除用户（离职人员）：
 *   - 关键业务引用检查（项目成员 / 负责阶段 / 任务指派 / 创建任务 / 文件 / 评论 /
 *     消息 / 文件条目负责人或审阅人 / 修订 / 标注 / 费用记录）→ 有任一引用即 400 拒绝，提示改用停用
 *   - 历史痕迹（会话 / 通知 / 待办 / 访问日志 / 会话成员 / 活动日志 / 授予的 ACL /
 *     NextAuth Account）→ 删除前级联清理（事务内，避免外键冲突 500）
 *   - 最后一个 ADMIN 不可删除（防锁死）
 *   - 无关键引用才物理删除
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
    await requireAdmin(request)

    const target = await prisma.user.findUnique({ where: { id: id } })
    if (!target) throw ApiError.notFound('用户不存在')

    // 防锁死：最后一个 ADMIN 不可删除
    if (target.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN', isActive: true } })
      if (adminCount <= 1) {
        throw ApiError.badRequest('系统至少需保留一名 ADMIN，无法删除最后一名管理员')
      }
    }

    // ── 关键业务引用检查：有任一引用即拒绝物理删除（建议改用停用）──
    const [
      projectMemberCount,
      phaseOwnerCount,
      taskAssigneeCount,
      taskCreatorCount,
      fileCount,
      commentCount,
      messageCount,
      requirementOwnerCount,
      requirementReviewerCount,
      revisionCount,
      annotationCount,
      expenseRefCount,
    ] = await Promise.all([
      prisma.projectMember.count({ where: { userId: target.id } }),
      prisma.phase.count({ where: { ownerId: target.id } }),
      prisma.task.count({ where: { assigneeId: target.id } }),
      prisma.task.count({ where: { creatorId: target.id } }),
      prisma.file.count({ where: { uploadedById: target.id } }),
      prisma.comment.count({ where: { userId: target.id } }),
      prisma.message.count({ where: { senderId: target.id } }),
      prisma.fileRequirement.count({ where: { ownerId: target.id } }),
      prisma.fileRequirement.count({ where: { reviewerId: target.id } }),
      prisma.taskRevision.count({ where: { changedById: target.id } }),
      prisma.annotation.count({ where: { userId: target.id } }),
      // ★ 费用模块引用（报销单 payeeId/createdById/审批人 approvedById/打款人 paidById），防外键约束 500
      prisma.expenseClaim.count({
        where: {
          OR: [
            { payeeId: target.id },
            { createdById: target.id },
            { approvedById: target.id },
            { paidById: target.id },
          ],
        },
      }),
    ])

    const refTotal =
      projectMemberCount +
      phaseOwnerCount +
      taskAssigneeCount +
      taskCreatorCount +
      fileCount +
      commentCount +
      messageCount +
      requirementOwnerCount +
      requirementReviewerCount +
      revisionCount +
      annotationCount +
      expenseRefCount

    if (refTotal > 0) {
      throw ApiError.badRequest(
        `该用户存在 ${refTotal} 条业务引用（项目成员/任务/文件/费用等），无法删除，请改用「停用」保留历史数据`
      )
    }

    // ── 事务：级联清理历史痕迹 → 物理删除 ──
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId: target.id } }),
      prisma.notification.deleteMany({ where: { userId: target.id } }),
      prisma.todoItem.deleteMany({ where: { userId: target.id } }),
      prisma.fileAccessLog.deleteMany({ where: { userId: target.id } }),
      prisma.conversationMember.deleteMany({ where: { userId: target.id } }),
      prisma.activityLog.deleteMany({ where: { userId: target.id } }),
      prisma.resourcePermission.deleteMany({ where: { grantedById: target.id } }),
      prisma.account.deleteMany({ where: { userId: target.id } }),
      prisma.user.delete({ where: { id: target.id } }),
    ])

    return ok({ id: target.id, name: target.name }, '用户已删除')
  }
)
