// POST /api/ai/decompose-purchase — 采购清单 AI 分解
// 模式1（原文本）：{ text } → { items: [{name, spec, quantity, unit}] }
// 模式2（Excel）：{ mode:"excel", rows, header? } → { items: [{name,brand,supplierName,spec,param,quantity,unit,remark}], uncertain: [{row,reason}] }
// 设计：docs/设计方案-AI智能助手.md §五。只读：不落库，返回建议由用户在前端确认后走既有 API。
// ★ 2026-08-25 修复：DeepSeek v4-flash 为 reasoning 模型，reasoning_token 计入输出预算，
//   大清单单次调用必然 finish_reason=length 截断 → JSON 解析失败 → 静默返回 0 条。
//   改为「分块解析（每块 ≤ 50 行）+ 并发 2 + 截断/格式错误重试 + 递归拆半兜底 + 明确错误上报」。
// ★ 2026-08-25 夜间修复（线上实测复盘）：AI 做列映射本身不可靠 —— 同一文件三次请求
//   返回 7~11KB 残缺响应（名称/型号/品牌全空、只剩单位数量，且数量与真实行不对应），
//   用户看到「有行数但内容全空」的错乱表格。列映射是确定性问题，不该交给概率模型：
//   Excel 模式改为「确定性表头解析优先（0 次 AI 调用、毫秒级、100% 可复现），
//   仅当找不到表头时才回退 AI 分块解析」，并对 AI 兜底结果增加错位校验
//   （纯数字名称 = 列错位特征 → 丢弃并记 uncertain，不进入展示）。
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth } from '@/lib/api-helpers'
import { chatCompletion, MiMoError } from '@/lib/ai/mimo'
import {
  assertAiConfigured,
  extractJsonObject,
  miMoToApiError,
} from '@/lib/ai/api-utils'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** 输出条目上限（防模型刷屏） */
const MAX_ITEMS = 50
const MAX_EXCEL_ITEMS = 300
const MAX_ROWS = 200
/** ★ 确定性解析路径上限（无 AI 成本，可支持更大清单） */
const MAX_DETERMINISTIC_ROWS = 400
const MAX_DETERMINISTIC_ITEMS = 500
/** ★ 分块解析参数（防单次输出截断） */
const CHUNK_ROWS = 50
const CHUNK_CONCURRENCY = 2
const CHUNK_MAX_TOKENS = 16384
const CHUNK_TIMEOUT_MS = 60000
const CHUNK_MAX_ATTEMPTS = 3
const EXCEL_DEADLINE_MS = 250000

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
  /** ★ 2026-08-25 补：单价（Excel 单价/价格列，无则 null）——供订单/成本核算直接填充 */
  price: number | null
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
  '只输出严格 JSON 对象，不要解释、不要 Markdown 代码块。格式示例：',
  '{"items":[{"name":"三相异步电机","spec":"380V 5.5kW","quantity":2,"unit":"台"},{"name":"电缆","spec":"","quantity":3,"unit":"米"}]}',
].join('\n')

const EXCEL_PROMPT = [
  '你是项目管理系统的采购助手。用户上传了 Excel 采购清单，已转为 JSON 表格数据（header 为表头行，rows 为数据行矩阵；若 header 为空则 rows 第一行即表头）。',
  '请智能解析为统一明细，规则：',
  '1. 自动识别每列含义：品名（物料名称/名称/设备名…）、品牌、供应商（厂商/供货单位…）、规格型号（型号/规格…）、参数（技术参数/性能参数…）、数量、单位、备注（说明…）。表头可能是任意中文叫法，按表头名与列内容语义综合判断，忽略列顺序。',
  '2. 数量与单位清洗：数量列 "3台" 或 "3" 带 "台" → quantity=3、unit="台"；数量为纯数字且无单位信息 → unit="件"；数量无法解析默认 1。',
  '3. 规格与参数分开：型号类值（DN50、Y2-132M-4）→ spec；技术描述类值（380V 5.5kW、IP55）→ param；两列都有则都保留。',
  '4. supplierName 是供应商名称原文；没有供应商列则为空字符串。',
  '5. 单价列（单价/价格/含税单价…）→ price 数字（无则为 null）；总价/合计金额列不提取。',
  '6. 空行、合计行、标题行、无法识别出品名的行：记入 uncertain 数组（row = 该行在 rows 中的序号，从 1 开始；reason 一句话）。',
  '只输出严格 JSON 对象，不要解释、不要 Markdown 代码块。格式：',
  '{"items":[{"name":"不锈钢球阀","brand":"盾安","supplierName":"上海盾安阀门","spec":"DN50","param":"PN16","quantity":5,"unit":"个","price":88.5,"remark":"首批"}],"uncertain":[{"row":3,"reason":"合计行"}]}',
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

/** 单价单元格清洗：去千分位/货币符（￥¥$€£）/空白 → 非负数字；无法解析返回 null */
function parsePriceCell(raw: string): number | null {
  const t = (raw ?? '').replace(/[,，￥¥$€£\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null
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
    price: o.price == null ? null : parsePriceCell(String(o.price)),
  }
}

function normalizeUncertain(raw: unknown): UncertainRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const row = Number(o.row)
  if (!Number.isInteger(row) || row < 1) return null
  return { row, reason: str(o.reason, 120) || '无法识别' }
}

// ─────────────── ★ 2026-08-25 夜间：确定性表头解析（优先于 AI）───────────────

/** 表头关键词 → 标准字段（按优先级匹配，首个命中即绑定该列） */
const HEADER_RULES: Array<{ field: keyof ExcelItem | 'seq'; keywords: string[] }> = [
  { field: 'seq', keywords: ['序号', '编号', '项号', 'no', 'No', '#'] },
  { field: 'name', keywords: ['品名', '物料名称', '物料名', '名称', '设备名', '材料名', '项目名称', '品名规格', '货物名称', '名称规格'] },
  { field: 'spec', keywords: ['规格型号', '型号规格', '型号', '规格'] },
  { field: 'param', keywords: ['技术参数', '性能参数', '参数', '技术要求', '参数要求'] },
  { field: 'quantity', keywords: ['采购数量', '数量', ' qty', 'Qty'] },
  { field: 'unit', keywords: ['单位', '计量单位'] },
  { field: 'brand', keywords: ['品牌', '厂家', '厂商'] },
  { field: 'price', keywords: ['含税单价', '不含税单价', '采购单价', '单价', '价格'] },
  { field: 'supplierName', keywords: ['供应商', '供货单位', '供货商', '供应商名称', '厂商名称'] },
  { field: 'remark', keywords: ['备注', '说明', '用途', '需求日期', '备注说明'] },
]

interface ColMap {
  headerRowIdx: number
  cols: Partial<Record<keyof ExcelItem | 'seq', number>>
}

/** 在矩阵前 15 行内探测表头行：名称列必须命中，且至少再命中 数量/单位/型号/参数/品牌 之一 */
function detectHeader(matrix: string[][]): ColMap | null {
  const scanRows = Math.min(15, matrix.length)
  for (let i = 0; i < scanRows; i++) {
    const row = matrix[i]!
    const cols: Partial<Record<keyof ExcelItem | 'seq', number>> = {}
    const used = new Set<number>()
    for (const { field, keywords } of HEADER_RULES) {
      for (let c = 0; c < row.length; c++) {
        if (used.has(c)) continue
        const cell = (row[c] ?? '').replace(/[\s::　]/g, '')
        if (!cell) continue
        if (keywords.some((k) => cell.toLowerCase() === k.toLowerCase().replace(/\s/g, '') || cell.toLowerCase().includes(k.toLowerCase()))) {
          cols[field] = c
          used.add(c)
          break
        }
      }
    }
    if (cols.name !== undefined) {
      const anchors = [cols.quantity, cols.unit, cols.spec, cols.param, cols.brand].filter((x) => x !== undefined)
      if (anchors.length >= 1) return { headerRowIdx: i, cols }
    }
  }
  return null
}

/** 数量/单位单元格清洗："3台" → (3, 台)；千分位"1,400"→1400；数量无法解析返回 null */
function parseQtyUnit(qtyCell: string, unitCell: string): { quantity: number; unit: string } | null {
  const q = (qtyCell ?? '').trim().replace(/(?<=\d)[,，](?=\d)/g, '')
  if (!q) return null
  const m = q.match(/^(\d+(?:\.\d+)?)\s*([^\d\s]{0,4})?$/)
  if (!m) return null
  const quantity = Number(m[1])
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  let unit = (m[2] ?? '').trim()
  if (!unit) unit = (unitCell ?? '').trim()
  return { quantity, unit: unit ? unit.slice(0, 20) : '件' }
}

/** 分区/合计/标题行判定：名称列命中即跳过 */
function isNonDataName(name: string): string | null {
  if (!name.trim()) return '无名称'
  if (/合\s*计|小\s*计|总\s*计/.test(name)) return '合计行'
  if (/^(第?[一二三四五六七八九十\d]+[、.．]|阶段|区域|单元|部分|模块)[:：]?\s*\S+$/.test(name) && name.length <= 30) {
    // 形如 “A-热水单元 & C-静置清汁” 的分区行：整行仅序号列+名称列+个别汇总列有值
    return null // 交给调用方结合整行稀疏度判断
  }
  return null
}

/**
 * 确定性解析：表头列映射 + 逐行提取。返回 null 表示不适合确定性路径（交 AI 兜底）。
 * 行号约定与 AI 路径一致：uncertain.row = 该行在入参 rows 中的 1-based 序号。
 */
function parseDeterministic(matrix: string[][]): { items: ExcelItem[]; uncertain: UncertainRow[]; headerRowIdx: number } | null {
  const detected = detectHeader(matrix)
  if (!detected) return null
  const { headerRowIdx, cols } = detected
  const items: ExcelItem[] = []
  const uncertain: UncertainRow[] = []
  const nameCol = cols.name!
  const rowLen = Math.max(...matrix.map((r) => r.length))

  for (let i = 0; i < matrix.length; i++) {
    if (i === headerRowIdx) {
      uncertain.push({ row: i + 1, reason: '表头行' })
      continue
    }
    const row = matrix[i]!
    const name = (row[nameCol] ?? '').trim()
    // 跳过非数据行的判定
    const nonData = isNonDataName(name)
    const nonEmptyCells = row.filter((c) => c !== '').length
    if (nonData) {
      uncertain.push({ row: i + 1, reason: i < headerRowIdx ? '标题行' : nonData })
      continue
    }
    // 分区行特征：表头前为标题；表头后整行有效单元格 ≤ 3（仅名称+个别汇总值）且无数量
    if (i > headerRowIdx && nonEmptyCells <= 3) {
      const qtyCell = cols.quantity !== undefined ? (row[cols.quantity] ?? '') : ''
      if (!parseQtyUnit(qtyCell, cols.unit !== undefined ? (row[cols.unit] ?? '') : '')) {
        uncertain.push({ row: i + 1, reason: '分区/汇总行' })
        continue
      }
    }
    if (!name) {
      // 有数量但无名称 → 不能丢失，记 uncertain 提醒人工
      const qtyCell = cols.quantity !== undefined ? (row[cols.quantity] ?? '') : ''
      const qu = parseQtyUnit(qtyCell, cols.unit !== undefined ? (row[cols.unit] ?? '') : '')
      if (qu) uncertain.push({ row: i + 1, reason: '名称为空（该行有数量，请人工确认）' })
      else if (nonEmptyCells > 0 && i < headerRowIdx) uncertain.push({ row: i + 1, reason: '标题行' })
      continue
    }
    const qu = parseQtyUnit(
      cols.quantity !== undefined ? (row[cols.quantity] ?? '') : '',
      cols.unit !== undefined ? (row[cols.unit] ?? '') : '',
    )
    if (!qu) {
      // 名称存在但数量无法解析：保留行并默认 1，避免静默丢行（表头前标题行除外）
      if (i < headerRowIdx) {
        uncertain.push({ row: i + 1, reason: '标题行' })
        continue
      }
      items.push({
        name: name.slice(0, 200),
        brand: (cols.brand !== undefined ? (row[cols.brand] ?? '') : '').trim().slice(0, 100),
        supplierName: (cols.supplierName !== undefined ? (row[cols.supplierName] ?? '') : '').trim().slice(0, 150),
        spec: (cols.spec !== undefined ? (row[cols.spec] ?? '') : '').trim().slice(0, 300),
        param: (cols.param !== undefined ? (row[cols.param] ?? '') : '').trim().slice(0, 300),
        quantity: 1,
        unit: ((cols.unit !== undefined ? (row[cols.unit] ?? '') : '').trim() || '件').slice(0, 20),
        remark: (cols.remark !== undefined ? (row[cols.remark] ?? '') : '').trim().slice(0, 300),
        price: cols.price !== undefined ? parsePriceCell(row[cols.price] ?? '') : null,
      })
      continue
    }
    items.push({
      name: name.slice(0, 200),
      brand: (cols.brand !== undefined ? (row[cols.brand] ?? '') : '').trim().slice(0, 100),
      supplierName: (cols.supplierName !== undefined ? (row[cols.supplierName] ?? '') : '').trim().slice(0, 150),
      spec: (cols.spec !== undefined ? (row[cols.spec] ?? '') : '').trim().slice(0, 300),
      param: (cols.param !== undefined ? (row[cols.param] ?? '') : '').trim().slice(0, 300),
      quantity: qu.quantity,
      unit: qu.unit,
      remark: (cols.remark !== undefined ? (row[cols.remark] ?? '') : '').trim().slice(0, 300),
      price: cols.price !== undefined ? parsePriceCell(row[cols.price] ?? '') : null,
    })
    void rowLen
  }
  if (items.length === 0) return null
  return { items, uncertain, headerRowIdx }
}

/** 行数据 → 字符串矩阵（统一 string[][] 和 Record 两种入参形态；截断防爆 prompt；maxRows 可按路径指定） */
function toCellMatrix(rows: unknown[], header?: unknown[], maxRows = MAX_ROWS): string[][] {
  const normalized = rows.map((r) => {
    if (Array.isArray(r)) return r.map((c) => String(c ?? '').trim().slice(0, 200))
    if (typeof r === 'object' && r !== null) {
      const rec = r as Record<string, unknown>
      return Object.keys(rec).map((k) => String(rec[k] ?? '').trim().slice(0, 200))
    }
    return [String(r ?? '').slice(0, 200)]
  })
  const head = header ? [header.map((h) => String(h ?? '').trim().slice(0, 100))] : []
  return [...head, ...normalized].slice(0, maxRows).map((r) => r.slice(0, 40))
}

// ─────────────── ★ 2026-08-25 分块解析（防输出截断）───────────────

interface ParseOutcome {
  items: ExcelItem[]
  uncertain: UncertainRow[]
  /** 无法解析的块（给出具体行区间与原因，不静默） */
  failures: string[]
}

interface ChunkSpec {
  rows: string[][]
  /** 该块第一行在完整矩阵中的 0-based 下标（uncertain 行号换算用） */
  base: number
}

/** 单块单次 AI 调用：一次 chatCompletion + JSON 抽取。返回 null 表示本轮未拿到合法 items。 */
async function callAiChunkOnce(
  rows: string[][],
  header: string[] | null,
  label: string,
  isFirstChunk: boolean,
  attempt: number,
): Promise<{ parsed: { items: unknown[]; uncertain?: unknown[] } | null; truncated: boolean }> {
  const note =
    (header
      ? 'header 为表头行（可能不是真正列名，仅供参考）；rows 为数据行，不含表头。'
      : isFirstChunk
        ? 'rows 第 1 行可能是标题行或表头行：若为表头/标题类行请记入 uncertain，不要当作物料。'
        : 'rows 全部为数据行（无表头、无标题行）：第 1 行也是物料，不要跳过任何行。') +
    ' ' + label +
    (attempt > 0
      ? '\n【注意】上一次输出不合法（JSON 解析失败或输出超长被截断）。请严格只输出 JSON 对象，不要任何解释文字、不要 Markdown 围栏；每个物料一行，省略所有空字符串字段。'
      : '')
  const res = await chatCompletion(
    [
      { role: 'system', content: EXCEL_PROMPT },
      { role: 'user', content: JSON.stringify({ header: header ?? undefined, rows, note }) },
    ],
    {
      temperature: 0,
      max_completion_tokens: CHUNK_MAX_TOKENS,
      timeoutMs: CHUNK_TIMEOUT_MS,
      jsonMode: true,
    },
  )
  const candidate = res.content ? extractJsonObject(res.content) : null
  if (candidate && Array.isArray(candidate.items)) {
    return { parsed: candidate as unknown as { items: unknown[]; uncertain?: unknown[] }, truncated: false }
  }
  return { parsed: null, truncated: res.finishReason === 'length' }
}

/**
 * 单块解析：最多 CHUNK_MAX_ATTEMPTS 次（截断/格式错误携带纠正提示重试）；
 * 仍失败且块 ≥ 2 行 → 递归拆半兜底；再失败记录明确原因（不静默）。
 */
async function parseChunk(
  chunk: ChunkSpec,
  header: string[] | null,
  depth = 0,
): Promise<ParseOutcome> {
  const rows = chunk.rows
  const label = `该块为清单第 ${chunk.base + 1}~${chunk.base + rows.length} 行。`
  let lastReason = ''
  for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
    try {
      const { parsed, truncated } = await callAiChunkOnce(rows, header, label, chunk.base === 0, attempt)
      if (parsed) {
        const items = (parsed.items as unknown[])
          .map(normalizeExcelItem)
          .filter((x): x is ExcelItem => x !== null)
        const uncertain = Array.isArray(parsed.uncertain)
          ? (parsed.uncertain as unknown[])
              .map(normalizeUncertain)
              .filter((x): x is UncertainRow => x !== null)
              .map((u) => ({ ...u, row: chunk.base + u.row })) // 换算为完整矩阵行号
          : []
        return { items, uncertain, failures: [] }
      }
      lastReason = truncated ? 'AI 输出超长被截断（模型输出预算不足）' : 'AI 未返回符合格式的 JSON'
    } catch (err) {
      lastReason = err instanceof MiMoError ? `AI 服务异常：${err.message}` : 'AI 调用异常'
    }
  }
  // 递归拆半兜底
  if (rows.length >= 2 && depth < 3) {
    const mid = Math.ceil(rows.length / 2)
    const [a, b] = await Promise.all([
      parseChunk({ rows: rows.slice(0, mid), base: chunk.base }, header, depth + 1),
      parseChunk({ rows: rows.slice(mid), base: chunk.base + mid }, header, depth + 1),
    ])
    return {
      items: [...a.items, ...b.items],
      uncertain: [...a.uncertain, ...b.uncertain],
      failures: [...a.failures, ...b.failures],
    }
  }
  return { items: [], uncertain: [], failures: [`第 ${chunk.base + 1}~${chunk.base + rows.length} 行解析失败：${lastReason}`] }
}

/** 并发 2 的小型任务池（保序返回） */
async function runChunks(
  chunks: ChunkSpec[],
  header: string[] | null,
  deadline: number,
): Promise<ParseOutcome> {
  const results = new Array<ParseOutcome | null>(chunks.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      if (Date.now() > deadline) {
        // 总时长保护：剩余块直接记为失败（明确原因，避免前端 axios 超时后得到无提示失败）
        for (let i = next; i < chunks.length; i++) {
          results[i] = {
            items: [],
            uncertain: [],
            failures: [`第 ${chunks[i]!.base + 1}~${chunks[i]!.base + chunks[i]!.rows.length} 行未解析：整体解析超时`],
          }
        }
        return
      }
      const i = next++
      results[i] = await parseChunk(chunks[i]!, header)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
  const merged: ParseOutcome = { items: [], uncertain: [], failures: [] }
  for (const r of results) {
    if (!r) continue
    merged.items.push(...r.items)
    merged.uncertain.push(...r.uncertain)
    merged.failures.push(...r.failures)
  }
  return merged
}

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const body = BodySchema.parse(await request.json())

  // ─────────────── 模式2：Excel 表格智能解析（★ 确定性优先 + AI 兜底）───────────────
  if (body.mode === 'excel' && body.rows) {
    // 确定性路径：先以更大的行数上限做全量矩阵（表头解析无 AI 成本、不耗限流/AI 配置）
    const fullMatrix = toCellMatrix(body.rows, body.header, MAX_DETERMINISTIC_ROWS)
    const det = parseDeterministic(fullMatrix)
    if (det) {
      const items = det.items.slice(0, MAX_DETERMINISTIC_ITEMS)
      const uncertain = det.uncertain.slice(0, 300)
      const msg =
        `已解析 ${items.length} 条明细（标准表头直读）` +
        (uncertain.length ? `，${uncertain.length} 行非明细行已跳过` : '') +
        (det.items.length > MAX_DETERMINISTIC_ITEMS ? `；清单超过 ${MAX_DETERMINISTIC_ITEMS} 条，仅保留前 ${MAX_DETERMINISTIC_ITEMS} 条` : '')
      return ok({ items, uncertain, warnings: [], parseMode: 'deterministic' }, msg)
    }

    // AI 兜底路径（无标准表头的乱表）：限流 + AI 配置检查在此分支才生效
    const rl = checkAiRateLimit(authUser.userId)
    if (!rl.allowed) {
      return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
    }
    assertAiConfigured()
    const matrix = toCellMatrix(body.rows, body.header).slice(0, MAX_ROWS)
    const header = body.header ? matrix[0]! : null
    const dataRows = body.header ? matrix.slice(1) : matrix

    // 分块（≤CHUNK_ROWS 行/块）；base = 该块首行在客户端 rows 数组中的序号偏移（0-based）
    const chunks: ChunkSpec[] = []
    for (let i = 0; i < dataRows.length; i += CHUNK_ROWS) {
      chunks.push({ rows: dataRows.slice(i, i + CHUNK_ROWS), base: i })
    }

    let outcome: ParseOutcome
    try {
      outcome = await runChunks(chunks, header, Date.now() + EXCEL_DEADLINE_MS)
    } catch (err) {
      throw miMoToApiError(err)
    }

    // ★ 错位校验：纯数字名称是列错位特征（模型把序号/数量列当成了品名），
    //   这类行进入展示就是「名称空/乱、只有数字」的错乱表格 —— 丢弃并记 uncertain
    const misaligned: UncertainRow[] = []
    const validItems: ExcelItem[] = []
    outcome.items.forEach((it, idx) => {
      if (/^\d+(\.\d+)?$/.test(it.name)) {
        misaligned.push({ row: idx + 1, reason: `名称为纯数字“${it.name}”，疑似 AI 列错位，请人工核对该行` })
      } else {
        validItems.push(it)
      }
    })
    const items = validItems.slice(0, MAX_EXCEL_ITEMS)
    const uncertain = [...misaligned, ...outcome.uncertain].slice(0, 200)

    // 全部失败 → 明确失败（前端可拿到具体原因），而非静默 0 条
    if (items.length === 0 && outcome.failures.length > 0 && uncertain.length === 0) {
      return fail(
        502,
        `AI 解析失败：${outcome.failures.slice(0, 3).join('；')}。请检查表格内容，或减少清单行数后重试，也可改用手工录入`,
        'AI_PARSE_FAILED',
        outcome.failures,
      )
    }

    let msg =
      `已解析 ${items.length} 条明细` +
      (uncertain.length ? `，${uncertain.length} 行待人工确认（第 ${uncertain.slice(0, 5).map((u) => u.row).join('/')} 行）` : '') +
      (outcome.failures.length ? `；${outcome.failures.length} 个分段未能解析：${outcome.failures.slice(0, 2).join('；')}` : '')
    return ok({ items, uncertain, warnings: outcome.failures, parseMode: 'ai' }, msg)
  }

  // ─────────────── 模式1：自由文本分解（★ jsonMode + 重试）───────────────
  const { text } = body as { text: string }
  const rlText = checkAiRateLimit(authUser.userId)
  if (!rlText.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rlText.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()
  let parsedObj: Record<string, unknown> | null = null
  let textTruncated = false
  try {
    for (let attempt = 0; attempt < 2 && !parsedObj; attempt++) {
      const res = await chatCompletion(
        [
          { role: 'system', content: PROMPT },
          { role: 'user', content: text },
        ],
        {
          temperature: 0,
          max_completion_tokens: 1536,
          timeoutMs: 30000,
          jsonMode: true,
        },
      )
      parsedObj = res.content ? extractJsonObject(res.content) : null
      textTruncated = res.finishReason === 'length'
    }
  } catch (err) {
    throw miMoToApiError(err)
  }
  const items = Array.isArray(parsedObj?.items)
    ? (parsedObj!.items as unknown[])
        .map(normalizeItem)
        .filter((x): x is ParsedItem => x !== null)
        .slice(0, MAX_ITEMS)
    : []

  if (items.length === 0) {
    return ok(
      { items: [] },
      textTruncated
        ? 'AI 输出超长被截断，未能生成完整明细；请缩短描述或分次提交'
        : 'AI 未能解析出明细，请换更明确的描述或直接手填',
    )
  }
  return ok({ items }, `已分解 ${items.length} 条明细`) 
})
