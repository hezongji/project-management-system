/**
 * Webhook 通知 Provider 层（P2-2）
 *
 * 企业微信 / 钉钉群机器人 markdown 消息卡片。provider 模式：各 provider 只管
 * 自己平台的 payload 组装与发送，上层由 webhook.ts 统一分发。
 *
 * 设计约束（硬性）：
 *   - 零新依赖：只用 Node 内置 fetch（Node ≥ 18）+ AbortController 超时
 *   - 绝不抛错：所有网络/解析异常在此层吞掉并返回 SendResult，保证不影响主流程
 */

/** 支持的 provider */
export type NotifyProvider = 'wecom' | 'dingtalk'

/** 统一的 markdown 消息（上层组装，provider 各自适配） */
export interface MarkdownMessage {
  /** 卡片标题（钉钉 markdown 需要独立 title 字段；企业微信并入 content） */
  title: string
  /** markdown 正文 */
  content: string
}

/** 单次发送结果 */
export interface SendResult {
  provider: NotifyProvider
  ok: boolean
  /** HTTP 状态码（发送成功时） */
  status?: number
  /** 失败原因（仅失败时） */
  error?: string
}

/** 请求超时（fire-and-forget 不阻塞主流程） */
const TIMEOUT_MS = 5000

/**
 * POST JSON（带超时）。
 * 返回 { status, body }；网络错误 / 超时在此抛错，由上层 sendMarkdown 捕获。
 */
async function postJson(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = await res.text()
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** 企业微信 markdown 消息 payload */
function wecomPayload(msg: MarkdownMessage): Record<string, unknown> {
  // 企业微信 markdown 卡片：标题直接并入 content 首行
  const content = `# ${msg.title}\n\n${msg.content}`
  return { msgtype: 'markdown', markdown: { content } }
}

/** 钉钉 markdown 消息 payload */
function dingtalkPayload(msg: MarkdownMessage): Record<string, unknown> {
  return { msgtype: 'markdown', markdown: { title: msg.title, text: msg.content } }
}

/** 解析机器人响应（企业微信/钉钉均返回 { errcode, errmsg }） */
function parseRobotResponse(body: string): { ok: boolean; error?: string } {
  try {
    const json = JSON.parse(body) as { errcode?: number; errmsg?: string }
    if (json.errcode === 0) return { ok: true }
    return { ok: false, error: json.errmsg || `errcode=${json.errcode}` }
  } catch {
    // 非 JSON 响应：只要 HTTP 2xx 就视为已送达（部分网关不返回标准体）
    return { ok: true }
  }
}

/** 企业微信发送 */
export async function sendWecom(webhookUrl: string, msg: MarkdownMessage): Promise<SendResult> {
  try {
    const { status, body } = await postJson(webhookUrl, wecomPayload(msg))
    const parsed = parseRobotResponse(body)
    if (status >= 200 && status < 300 && parsed.ok) {
      return { provider: 'wecom', ok: true, status }
    }
    return { provider: 'wecom', ok: false, status, error: parsed.error ?? `HTTP ${status}` }
  } catch (err) {
    return { provider: 'wecom', ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 钉钉发送 */
export async function sendDingtalk(webhookUrl: string, msg: MarkdownMessage): Promise<SendResult> {
  try {
    const { status, body } = await postJson(webhookUrl, dingtalkPayload(msg))
    const parsed = parseRobotResponse(body)
    if (status >= 200 && status < 300 && parsed.ok) {
      return { provider: 'dingtalk', ok: true, status }
    }
    return { provider: 'dingtalk', ok: false, status, error: parsed.error ?? `HTTP ${status}` }
  } catch (err) {
    return { provider: 'dingtalk', ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 按 provider 分发（上层唯一调用入口，永不抛错） */
export async function sendMarkdown(
  provider: NotifyProvider,
  webhookUrl: string,
  msg: MarkdownMessage,
): Promise<SendResult> {
  if (provider === 'wecom') return sendWecom(webhookUrl, msg)
  return sendDingtalk(webhookUrl, msg)
}
