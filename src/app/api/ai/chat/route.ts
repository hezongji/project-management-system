// POST /api/ai/chat — 全局 AI 助手对话（MiMo 驱动，工具循环，权限跟随）
// 设计：docs/设计方案-AI智能助手.md §五
// - body: { messages: [{role:'user'|'assistant', content}], stream?: boolean }
// - 工具循环 ≤6 轮；stream=true 走 SSE（先跑完工具循环拿最终文本，再切块推送——最简可靠方案）
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth, ApiError } from '@/lib/api-helpers'
import { chatCompletion, type MiMoMessage } from '@/lib/ai/mimo'
import { AI_TOOLS, executeTool } from '@/lib/ai/tools'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MAX_ROUNDS = 6

const BodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  stream: z.boolean().optional().default(false),
})

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    '你是「PM 系统」的内置 AI 助手，帮助项目管理系统（华澄智能装备有限公司）的用户高效工作。',
    `今天是 ${today}。`,
    '',
    '数据使用铁律：',
    '1. 你只能通过提供的工具（query_*）查询系统数据；工具返回的数据已经按当前用户的权限过滤和脱敏，这就是该用户能看到的全部范围。',
    '2. 严禁编造数据。工具查不到（visible:false / 空列表 / 金额为 null）就如实说「看不到/无权限/暂无」，不要推测或虚构项目、任务、金额。',
    '3. 回答用简体中文，简洁直接：先给结论，再给关键细节；数据类回答注明来源工具和命中条数。',
    '4. 可以做的事：汇总项目/任务/采购/文件状态、解读数据、操作指引（页面入口）、把复杂问题拆解成步骤建议。',
    '5. 你是只读助手，不代用户改数据；涉及写操作时指引用户去对应页面操作。',
  ].join('\n')
}

/** 跑完整工具循环，返回最终文本 + 工具轨迹 */
async function runToolLoop(
  authUser: ReturnType<typeof requireAuth>,
  history: MiMoMessage[],
): Promise<{ content: string; toolTrace: string[] }> {
  const msgs: MiMoMessage[] = [{ role: 'system', content: buildSystemPrompt() }, ...history]
  const toolTrace: string[] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const isLastRound = round === MAX_ROUNDS - 1
    const res = await chatCompletion(msgs, {
      tools: isLastRound ? undefined : AI_TOOLS,
      tool_choice: isLastRound ? 'none' : 'auto',
      max_completion_tokens: 4096, // DeepSeek reasoning 消耗输出 token，2048 易被思考吃空
    })
    if (res.toolCalls && res.toolCalls.length > 0 && !isLastRound) {
      // 回填 assistant 工具调用消息，再逐条执行工具
      msgs.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls })
      for (const call of res.toolCalls) {
        let result: string
        try {
          const args = call.function.arguments
            ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
            : {}
          result = await executeTool(call.function.name, args, authUser)
        } catch (err) {
          result = JSON.stringify({
            error: true,
            message: err instanceof Error ? err.message : '工具调用失败',
          })
        }
        toolTrace.push(call.function.name)
        msgs.push({ role: 'tool', content: result, tool_call_id: call.id })
      }
      continue
    }
    const text = res.content?.trim()
    if (text) {
      // ★ MiMo 偶发把 tool_call 当文本输出（tool_choice:none 后仍残留）：剥离工具标记，只留正文
      const cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
      if (cleaned) return { content: cleaned, toolTrace }
      // 剥完为空 → 当作空 content 处理，走下方重试逻辑
    }
    // 思考型模型偶发空 content（token 耗在 reasoning）：最后再补一轮不带工具的小请求
    if (isLastRound) throw new ApiError(502, 'AI 暂时没有返回内容，请重试', 'AI_EMPTY')
  }
  throw new ApiError(502, 'AI 工具循环超限，请缩小问题范围后重试', 'AI_LOOP_LIMIT')
}

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const rl = checkAiRateLimit(authUser.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail(400, '输入数据格式错误', 'VALIDATION_ERROR', parsed.error.issues)
  const { messages, stream } = parsed.data

  try {
    const { content, toolTrace } = await runToolLoop(authUser, messages as MiMoMessage[])
    if (!stream) {
      return ok({ content, toolsUsed: toolTrace })
    }
    // SSE：先跑完工具循环拿最终文本，再按块推送（最简可靠；工具调用阶段客户端显示"思考中"）
    const encoder = new TextEncoder()
    const CHUNK = 24
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        try {
          if (toolTrace.length > 0) send({ type: 'tools', tools: toolTrace })
          for (let i = 0; i < content.length; i += CHUNK) {
            send({ type: 'delta', delta: content.slice(i, i + CHUNK) })
            await new Promise((r) => setTimeout(r, 12))
          }
          send({ type: 'done' })
        } finally {
          controller.close()
        }
      },
    })
    return new NextResponse(sse, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    const msg = err instanceof Error ? err.message : 'AI 服务调用失败'
    return fail(502, `AI 助手暂时不可用：${msg}`, 'AI_UPSTREAM')
  }
})
