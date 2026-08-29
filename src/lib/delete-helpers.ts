/**
 * 统一删除帮助函数 —— 依据《docs/设计方案-删除与垃圾清理.md》§2 / §5
 *
 * 铁律对齐：
 *   §2.3 引用保护：assertDeletable —— 关键业务引用 >0 时 400 拒绝并提示替代方案；
 *   §2.4 级联清理：cleanupUserTraces —— 无引用历史痕迹事务内级联删除；
 *   §2.5 审计留痕：logDelete —— 所有删除动作写 ActivityLog，沿用系统既有写入模式。
 *
 * 注意：ActivityLog 既有 schema 为 { projectId?, userId, action, detail }，
 * 无独立 operatorId/targetType/targetId 字段，此处按现状映射：
 *   operatorId → userId；targetType → action 前缀（`${targetType}.delete`）；
 *   targetId/其余明细 → detail JSON。
 */

import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/api-helpers'
import type { Prisma } from '@prisma/client'

// ───────────────────────── 引用保护（§2.3）─────────────────────────

/**
 * 关键业务引用计数守卫：count > 0 时抛 ApiError(400) 并提示替代方案。
 * 用法：先按实体统计引用数，再 assertDeletable(count, '该XX')。
 *
 * @param count 引用计数（各外键 count 之和）
 * @param label 实体描述，如「该项目」「该采购合同」（默认「该记录」）
 */
export function assertDeletable(count: number, label = '该记录'): void {
  if (count > 0) {
    throw ApiError.badRequest(
      `${label}存在 ${count} 条业务引用，无法删除；被关键业务/财务审计链引用的实体请改用「作废 / 停用 / 归档」保留历史数据`
    )
  }
}

// ───────────────────────── 级联清理（§2.4）─────────────────────────

/** 用户历史痕迹级联清理结果（各表删除条数） */
export interface UserTracesCleanupResult {
  sessions: number
  notifications: number
  todoItems: number
  fileAccessLogs: number
  conversationMembers: number
  activityLogs: number
  resourcePermissions: number
  accounts: number
}

/**
 * 级联清理用户历史痕迹（会话/通知/待办/访问日志/会话成员/活动日志/授予的 ACL/
 * NextAuth Account）—— 与 src/app/api/admin/users/[id]/route.ts 既有实现保持一致，
 * 但不删除 User 本身（是否物理删除由调用方在引用检查通过后决定）。
 *
 * 未传 tx 时自动开启事务；传入 tx 则复用调用方事务（嵌套场景）。
 */
export async function cleanupUserTraces(
  userId: string,
  tx?: Prisma.TransactionClient
): Promise<UserTracesCleanupResult> {
  const run = async (db: Prisma.TransactionClient): Promise<UserTracesCleanupResult> => {
    // 顺序删除；原子性由外层 $transaction 保证（tx 复用时由调用方事务保证）
    const sessions = await db.session.deleteMany({ where: { userId } })
    const notifications = await db.notification.deleteMany({ where: { userId } })
    const todoItems = await db.todoItem.deleteMany({ where: { userId } })
    const fileAccessLogs = await db.fileAccessLog.deleteMany({ where: { userId } })
    const conversationMembers = await db.conversationMember.deleteMany({ where: { userId } })
    const activityLogs = await db.activityLog.deleteMany({ where: { userId } })
    const resourcePermissions = await db.resourcePermission.deleteMany({ where: { grantedById: userId } })
    const accounts = await db.account.deleteMany({ where: { userId } })
    return {
      sessions: sessions.count,
      notifications: notifications.count,
      todoItems: todoItems.count,
      fileAccessLogs: fileAccessLogs.count,
      conversationMembers: conversationMembers.count,
      activityLogs: activityLogs.count,
      resourcePermissions: resourcePermissions.count,
      accounts: accounts.count,
    }
  }

  return tx ? run(tx) : prisma.$transaction(run)
}

// ───────────────────────── 审计留痕（§2.5）─────────────────────────

/**
 * 删除动作审计封装：写一条 ActivityLog。
 *
 * 字段按既有 schema 映射（userId=操作人，action=`${targetType}.delete`，
 * detail 内携带 targetId 与其余明细）。
 *
 * @param operatorId 操作人用户 ID（写入 ActivityLog.userId）
 * @param targetType 目标类型，如 'project' / 'task' / 'purchaseOrder'（action 前缀）
 * @param targetId   被删除实体 ID
 * @param detail     其余审计明细（名称、影响范围、原因等），可选
 * @param projectId  关联项目 ID（ActivityLog.projectId 可空），可选
 */
export async function logDelete(
  operatorId: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
  projectId?: string | null
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      projectId: projectId ?? null,
      userId: operatorId,
      action: `${targetType}.delete`,
      detail: { targetId, ...(detail ?? {}) } as unknown as Prisma.InputJsonValue,
    },
  })
}
