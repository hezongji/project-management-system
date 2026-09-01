/**
 * Webhook 通知服务（P2-2）
 *
 * 通用任务事件 → 企业微信 / 钉钉群机器人 markdown 消息卡片。
 *
 * 职责：
 *   - 从环境变量读取 webhook 地址（WECOM_WEBHOOK_URL / DINGTALK_WEBHOOK_URL，均可选）
 *   - 组装任务事件（创建 / 指派 / 状态变更）的统一 markdown
 *   - 分发到所有已配置 provider（未配置静默跳过）
 *
 * 硬性约束：
 *   - fire-and-forget：调用方 `void notifyXxx(...)` 不 await，绝不阻塞 / 影响主流程
 *   - 永不抛错：本模块所有函数吞掉一切异常，失败仅 console.error 留痕
 *   - 零新依赖：只用 Node 内置 fetch（见 providers.ts）
 *
 * 注意：本目录（src/lib/notify/）与根下 src/lib/notify.ts（浏览器桌面通知）
 * 是两套独立实现，勿混淆。
 */

import { sendMarkdown, type NotifyProvider, type MarkdownMessage } from './providers'

/** 任务状态 → 中文标签 */
const STATUS_LABELS: Record<string, string> = {
  TODO: '待办',
  IN_PROGRESS: '进行中',
  REVIEW: '评审中',
  DONE: '已完成',
  CANCELLED: '已取消',
}

/** 任务事件上下文（上层埋点传入） */
export interface TaskEventContext {
  projectId: string
  projectName?: string
  taskId: string
  taskTitle: string
  /** 操作人姓名（创建者 / 变更者） */
  operatorName?: string
  /** 负责人姓名（被指派者） */
  assigneeName?: string
  /** 状态变更时：原状态 */
  fromStatus?: string
  /** 状态变更时：新状态 */
  toStatus?: string
}

/** 站点地址（构造任务链接用，缺失则退化为纯文本） */
function siteBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ''
  ).replace(/\/+$/, '')
}

/** 任务详情链接（可空） */
function taskUrl(ctx: TaskEventContext): string {
  const base = siteBaseUrl()
  if (!base) return ''
  return `${base}/projects/${ctx.projectId}/tasks/${ctx.taskId}`
}

/** 标题内联链接（无 base 时退化为纯文本） */
function taskTitleLine(ctx: TaskEventContext): string {
  const url = taskUrl(ctx)
  return url ? `[${ctx.taskTitle}](${url})` : ctx.taskTitle
}

/** 读取已配置的 provider（未配置静默跳过） */
export function configuredProviders(): { provider: NotifyProvider; url: string }[] {
  const list: { provider: NotifyProvider; url: string }[] = []
  const wecom = process.env.WECOM_WEBHOOK_URL?.trim()
  const dingtalk = process.env.DINGTALK_WEBHOOK_URL?.trim()
  if (wecom) list.push({ provider: 'wecom', url: wecom })
  if (dingtalk) list.push({ provider: 'dingtalk', url: dingtalk })
  return list
}

/**
 * 分发一条 markdown 到所有已配置 provider。
 * 永不抛错：内部 provider 层已全吞异常。
 */
export async function dispatchMarkdown(msg: MarkdownMessage): Promise<void> {
  const targets = configuredProviders()
  if (targets.length === 0) return // 未配置 → 静默跳过
  await Promise.all(
    targets.map(async ({ provider, url }) => {
      const result = await sendMarkdown(provider, url, msg)
      if (!result.ok) {
        // 通知失败绝不影响主流程，仅留痕
        console.error(`[notify] ${provider} 发送失败:`, result.error ?? result.status)
      }
    }),
  )
}

// ───────────────────────────── 任务事件 ─────────────────────────────

/** 任务创建 */
export async function notifyTaskCreated(ctx: TaskEventContext): Promise<void> {
  const lines = [
    `**项目**：${ctx.projectName || ctx.projectId}`,
    `**任务**：${taskTitleLine(ctx)}`,
  ]
  if (ctx.assigneeName) lines.push(`**负责人**：${ctx.assigneeName}`)
  if (ctx.operatorName) lines.push(`**创建人**：${ctx.operatorName}`)
  await dispatchMarkdown({ title: '🆕 新任务已创建', content: lines.join('\n') })
}

/** 任务指派（负责人变更 / 新建即指派） */
export async function notifyTaskAssigned(ctx: TaskEventContext): Promise<void> {
  const lines = [
    `**项目**：${ctx.projectName || ctx.projectId}`,
    `**任务**：${taskTitleLine(ctx)}`,
    `**负责人**：${ctx.assigneeName || '（未指定）'}`,
  ]
  if (ctx.operatorName) lines.push(`**操作人**：${ctx.operatorName}`)
  await dispatchMarkdown({ title: '👤 任务已指派', content: lines.join('\n') })
}

/** 任务状态变更 */
export async function notifyTaskStatusChanged(ctx: TaskEventContext): Promise<void> {
  const from = STATUS_LABELS[ctx.fromStatus ?? ''] ?? ctx.fromStatus ?? '—'
  const to = STATUS_LABELS[ctx.toStatus ?? ''] ?? ctx.toStatus ?? '—'
  const lines = [
    `**项目**：${ctx.projectName || ctx.projectId}`,
    `**任务**：${taskTitleLine(ctx)}`,
    `**状态**：${from} → ${to}`,
  ]
  if (ctx.operatorName) lines.push(`**操作人**：${ctx.operatorName}`)
  await dispatchMarkdown({ title: '🔄 任务状态变更', content: lines.join('\n') })
}
