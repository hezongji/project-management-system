/**
 * 待办落库助手（todo-service）—— 依据《开发文档-项目管理系统重构》§7.9
 *
 * 提供「任务指派 → 新 assignee 写 TodoItem(sourceType=TASK)」的幂等落库，
 * 供任务创建（/api/tasks、/api/phases/:id/tasks）与改派（PATCH /api/tasks/:id）
 * 复用，保证「全源聚合」待办收件箱有数据。
 *
 * 幂等策略：同 (userId, sourceType, sourceId) 已存在「未完成」待办则跳过，
 * 避免重复改派到同一人时产生重复待办。
 */

import { Prisma, TaskPriority } from '@prisma/client'

/** 可执行事务的 Prisma 客户端形态（PrismaClient 与 TransactionClient 通用） */
export type TodoTx = Prisma.TransactionClient

export interface TaskTodoInput {
  assigneeId: string
  taskId: string
  title: string
  projectId: string
  dueDate: Date | null
  priority: TaskPriority
}

/**
 * 任务指派 → 给新 assignee 写待办（§7.9）。
 * 必须在调用方事务 tx 内调用，保证原子性。
 */
export async function ensureTaskTodo(tx: TodoTx, input: TaskTodoInput): Promise<void> {
  const existing = await tx.todoItem.findFirst({
    where: {
      userId: input.assigneeId,
      sourceType: 'TASK',
      sourceId: input.taskId,
      doneAt: null,
    },
    select: { id: true },
  })
  if (existing) return

  await tx.todoItem.create({
    data: {
      userId: input.assigneeId,
      title: `任务待办：${input.title}`,
      sourceType: 'TASK',
      sourceId: input.taskId,
      link: `/projects/${input.projectId}/tasks/${input.taskId}`,
      dueAt: input.dueDate,
      priority: input.priority,
    },
  })
}

/** 任务指派 → TASK_ASSIGNED 通知正文（供各落库点复用，避免三处写重复文案） */
export function taskAssignedPayload(title: string, projectId: string, taskId: string) {
  return {
    type: 'TASK_ASSIGNED' as const,
    title: `任务已指派给你：${title}`,
    body: `项目内任务「${title}」指派给你，请及时处理`,
    link: `/projects/${projectId}/tasks/${taskId}`,
  }
}
