// POST /api/ai/autofill — 表单 AI 自动填充建议（上下文+目标字段+原始输入 → 字段值建议）
// 设计：docs/设计方案-AI智能助手.md §五。只读：不落库，只返回建议，由用户确认后走既有表单提交。
// body: { context, fields: string[], input }  →  { suggestions: Record<field, value> }
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth } from '@/lib/api-helpers'
import { chatCompletion } from '@/lib/ai/mimo'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'
import { assertAiConfigured, extractJsonObject, miMoToApiError } from '@/lib/ai/api-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const BodySchema = z.object({
  context: z.string().trim().min(2, '请描述表单用途').max(500),
  fields: z.array(z.string().trim().min(1).max(50)).min(1, '至少一个目标字段').max(20),
  input: z.string().trim().min(1, '请提供原始输入').max(4000),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const rl = checkAiRateLimit(authUser.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()
  const { context, fields, input } = BodySchema.parse(await request.json())

  const prompt = [
    '你是项目管理系统的表单填写助手。根据「表单用途」和「用户原始输入」，为目标字段生成建议值。',
    '规则：',
    '1. 只输出严格 JSON 对象：{"suggestions":{"字段名":"建议值", ...}}，不要解释、不要 Markdown 代码块',
    '2. 目标字段列表中每个字段都必须出现在 suggestions 里；无法从输入推断的字段值为空字符串 ""',
    '3. 值一律为字符串；数字字段也用字符串表示（如 "2"）',
    '4. 忠实于用户输入，不编造依据不足的值',
    '',
    `表单用途：${context}`,
    `目标字段：${JSON.stringify(fields)}`,
  ].join('\n')

  let content: string | null
  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: input },
      ],
      { temperature: 0.2, max_completion_tokens: 1536, timeoutMs: 45000 },
    )
    content = res.content
  } catch (err) {
    throw miMoToApiError(err)
  }

  const parsed = content ? extractJsonObject(content) : null
  const rawSuggestions =
    parsed && typeof parsed.suggestions === 'object' && parsed.suggestions !== null && !Array.isArray(parsed.suggestions)
      ? (parsed.suggestions as Record<string, unknown>)
      : {}

  // 归一化：只保留请求的字段，值统一转字符串
  const allowed = new Set(fields)
  const suggestions: Record<string, string> = {}
  for (const f of fields) {
    const v = rawSuggestions[f]
    if (v === undefined || v === null) {
      suggestions[f] = ''
      continue
    }
    suggestions[f] = typeof v === 'string' ? v.slice(0, 500) : String(v).slice(0, 500)
  }

  return ok({ suggestions }, allowed.size > 0 ? '已生成填充建议' : 'ok')
})
