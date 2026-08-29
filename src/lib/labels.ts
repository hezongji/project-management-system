/**
 * 全系统中英文标签映射（§12.5 中文文案集中管理）
 * 统一把枚举值（英文）显示为中文标签，禁止前端直接渲染英文枚举。
 */

/** 项目状态 */
export const PROJECT_STATUS: Record<string, string> = {
  ACTIVE: '进行中',
  ON_HOLD: '暂停',
  COMPLETED: '已完成',
  CANCELLED: '已作废',
}

/** 优先级（项目/任务通用） */
export const PRIORITY: Record<string, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
}

/** 任务状态 */
export const TASK_STATUS: Record<string, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  REVIEW: '评审中',
  DONE: '已完成',
  CANCELLED: '已取消',
}

/** 阶段状态 */
export const PHASE_STATUS: Record<string, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  PAUSED: '已暂停',
  DONE: '已完成',
  SKIPPED: '已跳过',
}

/** 文件条目状态 */
export const FILE_STATUS: Record<string, string> = {
  WAITING: '待提交',
  SUBMITTED: '已提交',
  REVIEWING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  NA: '不适用',
  OBSOLETED: '已作废',
}

/** 文件范围 */
export const FILE_SCOPE: Record<string, string> = {
  PUBLIC: '公开',
  RESTRICTED: '受限',
  PRIVATE: '私有',
}

/** 兜底：取不到映射时返回原值或占位 */
export function label(map: Record<string, string>, key: string | null | undefined, fallback = '—'): string {
  if (!key) return fallback
  return map[key] ?? key
}
