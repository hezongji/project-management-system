// POST /api/ai/decompose-purchase — 采购清单 AI 分解
// 模式1（原文本）：{ text } → { items: [{name, spec, quantity, unit}] }
// 模式2（Excel）：{ mode:"excel", rows, header? } → { items: [{name,brand,supplierName,spec,param,quantity,unit,remark}], uncertain: [{row,reason}] }
// 设计：docs/设计方案-AI智能助手.md §五。只读：不落库，返回建议由用户在前端确认后走既有 API。
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth } from '@/lib/api-helpers'
import { chatCompletion } from '@/lib/ai/mimo'
import {
  assertAiConfigured,
  extractJsonArray,
  extractJsonObject,
  miMoToApiError,
} from '@/lib/ai/api-utils'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** 输出条目上限（防模型刷屏） */
const MAX_ITEMS = 50
const MAX_EXCEL_ITEMS = 100
const MAX_ROWS = 200

const BodySchema = z
  .object({
    mode: z.enum(['text', 'excel']).optional(), // 缺省 = 原文本模式
    text: z.string().trim().min(2, '请输入采购需求描述').max(4000).optional(),
    rows: z
      .array(z.union([z.array(z.union([z.string(), z.number()])), z.record(z.union([z.string(), z.number()]))]))
      .optional(),
    header: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'excel') {
      if (!v.rows || v.rows.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Excel 数据为空' })
      }
    } else {
      if (!v.text || v.text.length < 2) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请输入采购需求描述' })
      }
    }
  })

interface ParsedItem {
  name: string
  spec: string
  quantity: number
  unit: string
}

interface ExcelItem {
  name: string
  brand: string
  supplierName: string
  spec: string
  param: string
  quantity: number
  unit: string
  remark: string
}

interface UncertainRow {
  row: number
  reason: string
}

const PROMPT = [
  '你是项目管理系统的采购助手。把用户的采购需求描述拆解为结构化明细清单。',
  '规则：',
  '1. 按物理物件拆分，每件一行（例：「2台三相异步电机380V 5.5kW，3米电缆」拆成 2 条）',
  '2. quantity 是数字（条数/数量），未写明默认 1',
  '3. unit 是单位，未写明默认 "件"；原文有单位（台/米/个/套/箱/卷/桶…）则保留原文',
  '4. spec 提取型号/电压/功率/规格参数，没有则为空字符串',
  '5. name 是简洁名称（不含数量）',
  '只输出严格 JSON 数组，不要解释、不要 Markdown 代码块。格式示例：',
  '[{"name":"三相异步电机","spec":"380V 5.5kW","quantity":2,"unit":"台"},{"name":"电缆","spec":"","quantity":3,"unit":"米"}]',
].join('\n')

const EXCEL_PROMPT = [
  '你是项目管理系统的采购助手。用户上传了 Excel 采购清单，已转为 JSON 表格数据（header 为表头行，rows 为数据行矩阵；若 header 为空则 rows 第一行即表头）。',
  '请智能解析为统一明细，规则：',
  '1. 自动识别每列含义：品名（物料名称/名称/设备名…）、品牌、供应商（厂商/供货单位…）、规格型号（型号/规格…）、参数（技术参数/性能参数…）、数量、单位、备注（说明…）。表头可能是任意中文叫法，按表头名与列内容语义综合判断，忽略列顺序。',
  '2. 数量与单位清洗：数量列 "3台" 或 "3" 带 "台" → quantity=3、unit="台"；数量为纯数字且无单位信息 → unit="件"；数量无法解析默认 1。',
  '3. 规格与参数分开：型号类值（DN50、Y2-132M-4）→ spec；技术描述类值（380V 5.5kW、IP55）→ param；两列都有则都保留。',
  '4. supplierName 是供应商名称原文；没有供应商列则为空字符串。',
  '5. 空行、合计行、标题行、无法识别出品名的行：记入 uncertain 数组（row = 该行在 rows 中的序号，从 1 开始；reason 一句话）。',
  '只输出严格 JSON 对象，不要解释、不要 Markdown 代码块。格式：',
  '{"items":[{"name":"不锈钢球阀","brand":"盾安","supplierName":"上海盾安阀门","spec":"DN50","param":"PN16","quantity":5,"unit":"个","remark":"首批"}],"uncertain":[{"row":3,"reason":"合计行"}]}',
].join('\n')

/** 单条归一化：字段类型纠偏 + 缺省值，脏数据丢弃（文本模式） */
function normalizeItem(raw: unknown): ParsedItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  let quantity = 1
  if (typeof o.quantity === 'number' && Number.isFinite(o.quantity) && o.quantity > 0) {
    quantity = o.quantity
  } else if (typeof o.quantity === 'string' && o.quantity.trim()) {
    const n = Number(o.quantity)
    if (Number.isFinite(n) && n > 0) quantity = n
  }
  const spec = typeof o.spec === 'string' ? o.spec.trim() : ''
  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : '件'
  return { name: name.slice(0, 200), spec: spec.slice(0, 300), quantity, unit: unit.slice(0, 20) }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Excel 模式单条归一化：品名必须有，数量兜底 1 */
function normalizeExcelItem(raw: unknown): ExcelItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name) return null
  let quantity = 1
  if (typeof o.quantity === 'number' && Number.isFinite(o.quantity) && o.quantity > 0) {
    quantity = o.quantity
  } else if (typeof o.quantity === 'string' && o.quantity.trim()) {
    const n = Number(o.quantity)
    if (Number.isFinite(n) && n > 0) quantity = n
  }
  return {
    name: name.slice(0, 200),
    brand: str(o.brand, 100),
    supplierName: str(o.supplierName, 150),
    spec: str(o.spec, 300),
    param: str(o.param, 300),
    quantity,
    unit: (typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : '件').slice(0, 20),
    remark: str(o.remark, 300),
  }
}

function normalizeUncertain(raw: unknown): UncertainRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const row = Number(o.row)
  if (!Number.isInteger(row) || row < 1) return null
  return { row, reason: str(o.reason, 120) || '无法识别' }
}

/** 行数据 → 字符串矩阵（统一 string[][] 与 Record 两种入参形态；截断防爆 prompt） */
function toCellMatrix(rows: unknown[], header?: unknown[]): string[][] {
  const normalized = rows.map((r) => {
    if (Array.isArray(r)) return r.map((c) => String(c ?? '').trim().slice(0, 200))
    if (typeof r === 'object' && r !== null) {
      const rec = r as Record<string, unknown>
      return Object.keys(rec).map((k) => String(rec[k] ?? '').trim().slice(0, 200))
    }
    return [String(r ?? '').slice(0, 200)]
  })
  const head = header ? [header.map((h) => String(h ?? '').trim().slice(0, 100))] : []
  return [...head, ...normalized].slice(0, MAX_ROWS).map((r) => r.slice(0, 40))
}

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const rl = checkAiRateLimit(authUser.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()
  const body = BodySchema.parse(await request.json())

  // ─────────────── 模式2：Excel 表格智能解析 ───────────────
  if (body.mode === 'excel' && body.rows) {
    const matrix = toCellMatrix(body.rows, body.header)
    let content: string | null
    try {
      const res = await chatCompletion(
        [
          { role: 'system', content: EXCEL_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              header: body.header ? matrix[0] : undefined,
              rows: body.header ? matrix.slice(1) : matrix,
              note: 'rows 为 Excel 原始行（未去表头）' + (body.header ? '' : '，第 1 行即表头'),
            }),
          },
        ],
        { temperature: 0.1, max_completion_tokens: 6144, timeoutMs: 90000 },
      )
      content = res.content
    } catch (err) {
      throw miMoToApiError(err)
    }

    const parsed = content ? extractJsonObject(content) : null
    if (parsed === null || !Array.isArray(parsed.items)) {
      return ok({ items: [], uncertain: [] }, 'AI 未能解析该清单，请检查表格内容或改用手填')
    }
    const items = (parsed.items as unknown[])
      .map(normalizeExcelItem)
      .filter((x): x is ExcelItem => x !== null)
      .slice(0, MAX_EXCEL_ITEMS)
    const uncertain = Array.isArray(parsed.uncertain)
      ? (parsed.uncertain as unknown[])
          .map(normalizeUncertain)
          .filter((x): x is UncertainRow => x !== null)
          .slice(0, 100)
      : []
    const msg =
      `已解析 ${items.length} 条明细` +
      (uncertain.length ? `，${uncertain.length} 行待人工确认（第 ${uncertain.slice(0, 5).map((u) => u.row).join('/')} 行）` : '')
    return ok({ items, uncertain }, msg)
  }

  // ─────────────── 模式1：自由文本分解（原逻辑不动） ───────────────
  const { text } = body as { text: string }
  let content: string | null
  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: PROMPT },
        { role: 'user', content: text },
      ],
      { temperature: 0.1, max_completion_tokens: 1536, timeoutMs: 45000 },
    )
    content = res.content
  } catch (err) {
    throw miMoToApiError(err)
  }

  const parsed = content ? extractJsonArray(content) : null
  if (parsed === null) {
    return ok({ items: [] }, 'AI 未能解析出明细，请换更明确的描述或直接手填')
  }
  const items = parsed
    .map(normalizeItem)
    .filter((x): x is ParsedItem => x !== null)
    .slice(0, MAX_ITEMS)

  return ok({ items }, `已分解 ${items.length} 条明细`)
})
