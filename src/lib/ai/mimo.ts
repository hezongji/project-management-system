/**
 * AI 客户端（AI 智能助手地基）
 *
 * 2026-08-22 · 主用：DeepSeek（deepseek-v4-flash，api.deepseek.com，标准 Authorization: Bearer）
 * 端点 OpenAI chat/completions 兼容，纯 fetch 实现，不引第三方 SDK；支持 tools 函数调用。
 *
 * 配置优先级：AI_API_KEY/AI_BASE_URL/AI_MODEL > 旧 MIMO_API_KEY/MIMO_BASE_URL/MIMO_MODEL（MiMo 兼容回退）。
 * 认证：配了 AI_API_KEY → Authorization: Bearer；否则回退 MiMo 时代的 api-key 头。
 * DeepSeek 为 reasoning 模型：响应含 reasoning_content（思考）与 content（正文）；各路由只把 content
 * 作为正文返回/转发（SSE 只发 content delta，reasoning 静默丢弃，不发给前端）。
 *
 * 铁律（设计方案 §三）：AI 只通过工具查数据，客户端本身不做任何数据访问。
 */

export interface MiMoMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_calls?: MiMoToolCall[]
  tool_call_id?: string
}

export interface MiMoToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface MiMoChatOptions {
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  max_completion_tokens?: number
  temperature?: number
  /** 毫秒，默认 60000 */
  timeoutMs?: number
}

export interface MiMoChatResult {
  content: string | null
  reasoningContent: string | null
  toolCalls: MiMoToolCall[]
  finishReason: string
}


// ───────────────────────────── 环境与常量 ─────────────────────────────

export const MIMO_DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro'

function env(name: string, fallback: string): string {
  return process.env[name] || fallback
}

/** DeepSeek/Bearer 模式：配置了 AI_API_KEY 即启用（标准 Authorization 头 + max_tokens 参数） */
function bearerMode(): boolean {
  return !!process.env.AI_API_KEY
}

export function mimoBaseUrl(): string {
  return process.env.AI_BASE_URL || process.env.MIMO_BASE_URL || MIMO_DEFAULT_BASE_URL
}

export function mimoModel(): string {
  return process.env.AI_MODEL || process.env.MIMO_MODEL || MIMO_DEFAULT_MODEL
}

export function mimoApiKey(): string | undefined {
  return process.env.AI_API_KEY || process.env.MIMO_API_KEY
}

// ───────────────────────────── 错误归一化 ─────────────────────────────

export class MiMoError extends Error {
  status: number
  constructor(message: string, status = 500) {
    super(message)
    this.name = 'MiMoError'
    this.status = status
  }
}

function normalizeError(err: unknown, context: string): MiMoError {
  if (err instanceof MiMoError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new MiMoError(`MiMo ${context} 失败: ${msg}`)
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return `HTTP ${res.status}`
    try {
      const j = JSON.parse(text)
      return j?.error?.message || j?.message || text.slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return `HTTP ${res.status}`
  }
}

async function request(path: string, body: unknown, opts: MiMoChatOptions, timeoutMs: number): Promise<Response> {
  const key = mimoApiKey()
  if (!key) throw new MiMoError('AI_API_KEY（或旧 MIMO_API_KEY）未配置')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 配了 AI_API_KEY → DeepSeek 标准 Bearer；否则走 MiMo 时代 api-key 头（兼容回退）
    const headers: Record<string, string> = bearerMode()
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
      : { 'Content-Type': 'application/json', 'api-key': key }
    return await fetch(`${mimoBaseUrl()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MiMoError(`MiMo 请求超时（${timeoutMs}ms）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────── 非流式 ─────────────────────────────

/**
 * 非流式 chat completion。返回 content 与 reasoning_content（思考过程）。
 */
export async function chatCompletion(
  messages: MiMoMessage[],
  opts: MiMoChatOptions = {},
): Promise<MiMoChatResult> {
  const timeoutMs = opts.timeoutMs ?? 60000
  const body: Record<string, unknown> = {
    model: mimoModel(),
    messages,
  }
  if (opts.tools) body.tools = opts.tools
  if (opts.tool_choice) body.tool_choice = opts.tool_choice
  // Bearer/DeepSeek 模式：发 max_tokens（reasoning 消耗输出 token，缺省 4096 防空 content）
  // 旧 MiMo 模式：维持 max_completion_tokens，不传则不发（保持既有行为）
  if (bearerMode()) {
    body.max_tokens = opts.max_completion_tokens ?? 4096
  } else if (opts.max_completion_tokens !== undefined) {
    body.max_completion_tokens = opts.max_completion_tokens
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature

  let res: Response
  try {
    res = await request('/chat/completions', body, opts, timeoutMs)
  } catch (err) {
    throw normalizeError(err, '调用')
  }
  if (!res.ok) {
    throw new MiMoError(`MiMo 返回 ${res.status}: ${await parseErrorBody(res)}`, res.status)
  }

  let json: Record<string, unknown>
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    throw new MiMoError('MiMo 响应非合法 JSON')
  }

  const choice = Array.isArray(json.choices) && json.choices.length > 0 ? json.choices[0] : undefined
  if (!choice || typeof choice !== 'object') {
    throw new MiMoError('MiMo 响应缺少 choices')
  }
  const msg = (choice as { message?: Record<string, unknown> }).message ?? {}
  return {
    content: typeof msg.content === 'string' ? msg.content : null,
    reasoningContent: typeof msg.reasoning_content === 'string' ? (msg.reasoning_content as string) : null,
    toolCalls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as MiMoToolCall[]) : [],
    finishReason: typeof choice.finish_reason === 'string' ? (choice.finish_reason as string) : '',
  }
}
