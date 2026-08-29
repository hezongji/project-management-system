/**
 * IM 前端共享类型与工具 —— 依据《开发文档-项目管理系统重构》§8.2⑥ / §9.3
 *
 * - MessageItem 与卡片 payload 类型
 * - safeParseJson：type≠TEXT 时 content 为 JSON 串，容错解析（缺字段/坏 JSON 不崩）
 * - previewText：会话列表最后一条消息的人类可读预览（非 TEXT 折叠为 [标签]）
 * - formatMessageTime：气泡时间（今天 HH:mm / 昨天 / 日期）
 */

export type MsgType =
  | 'TEXT'
  | 'IMAGE'
  | 'FILE'
  | 'VOICE'
  | 'TASK_CARD'
  | 'PHASE_CARD'
  | 'SYSTEM'
  | 'REPORT'
  | 'ISSUE'

export interface FileMeta {
  name?: string | null
  size?: number | null
  mimeType?: string | null
  fileId?: string | null
  /** 归档归属（v1.1 W3）：发送时快照，历史消息缺字段不渲染归属行 */
  projectId?: string | null
  projectName?: string | null
  catalogName?: string | null
  /** 语音（v1.2 W5）：voiceId = /api/im/voice/:uuid 的 uuid */
  voiceId?: string | null
  duration?: number | null
}

export interface MessageSender {
  id: string
  name?: string | null
  email?: string
  avatar?: string | null
}

export interface MessageItem {
  id: string
  conversationId: string
  senderId: string
  sender: MessageSender | null
  type: string
  content: string
  replyToId?: string | null
  fileMeta?: FileMeta | null
  mentions?: string[] | null
  revoked: boolean
  createdAt: string
}

/** §9.3 TASK_CARD：{taskId,title,status,phaseName}（projectId 为可选扩展，缺失回退会话 projectId） */
export interface TaskCardData {
  taskId?: string
  title?: string
  status?: string
  phaseName?: string
  projectId?: string
}

/** §9.3 PHASE_CARD：{phaseId,name,progress,projectName} */
export interface PhaseCardData {
  phaseId?: string
  name?: string
  progress?: number
  projectName?: string
  projectId?: string
}

/** §9.3 ISSUE：{issueId,title,urgency,status,desc,images,assignee} */
export interface IssueCardData {
  issueId?: string
  title?: string
  urgency?: string
  status?: string
  desc?: string
  images?: string[]
  assignee?: string
}

/** §9.3 REPORT：{reportId,kind,date,done,plan,needHelp} */
export interface ReportCardData {
  reportId?: string
  kind?: string
  date?: string
  done?: string
  plan?: string
  needHelp?: string
}

/** 容错解析 type≠TEXT 的 JSON content；坏 JSON / 非对象返回 null，绝不抛错 */
export function safeParseJson<T>(content: string): T | null {
  if (!content) return null
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}

/** 会话列表最后一条消息的可读预览（非 TEXT 折叠为短标签） */
export function previewText(type: string, content: string): string {
  switch (type) {
    case 'TEXT':
      return content || ''
    case 'IMAGE':
      return '[图片]'
    case 'FILE':
      return '[文件]'
    case 'VOICE':
      return '[语音]'
    case 'SYSTEM':
      return content || '[系统消息]'
    case 'TASK_CARD': {
      const d = safeParseJson<TaskCardData>(content)
      return d?.title ? `[任务] ${d.title}` : '[任务卡片]'
    }
    case 'PHASE_CARD': {
      const d = safeParseJson<PhaseCardData>(content)
      return d?.name ? `[阶段] ${d.name}` : '[阶段卡片]'
    }
    case 'ISSUE': {
      const d = safeParseJson<IssueCardData>(content)
      return d?.title ? `[问题] ${d.title}` : '[问题上报]'
    }
    case 'REPORT': {
      const d = safeParseJson<ReportCardData>(content)
      return d?.kind ? `[汇报] ${d.kind}` : '[工作汇报]'
    }
    default:
      return content || ''
  }
}

/** 气泡时间：今天 HH:mm / 昨天 HH:mm / M月D日 HH:mm */
export function formatMessageTime(date: string | Date): string {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return hm

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`

  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
