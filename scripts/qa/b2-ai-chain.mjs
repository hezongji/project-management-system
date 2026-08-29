#!/usr/bin/env node
/**
 * QA B2a-2 —— AI 功能链 e2e（探活 + 降级，可重复执行的回归资产）
 *
 * 用法:
 *   node scripts/qa/b2-ai-chain.mjs                              # 默认打线上 https://pm.hezongji.cn/api
 *   BASE=http://127.0.0.1:3001/api node scripts/qa/b2-ai-chain.mjs
 *
 * 认证: 参照 scripts/e2e-full.mjs —— 读 /opt/pm-app/.env 的 JWT_SECRET，签 ADMIN Bearer。
 * 覆盖 6 个 AI 端点（最小合法载荷，按各 route.ts 的 zod schema 构造，输入尽量小控费）:
 *   /ai/chat               { messages:[{role:'user',content}] }        → 200 data.content 非空
 *   /ai/autofill           { context, fields:[title], input }         → 200 data.suggestions.title
 *   /ai/summarize          { type:'mine' }                            → 200 data.summary/stats
 *   /ai/decompose-purchase { text:'一行清单' }                        → 200 data.items[] ≥1
 *   /ai/meeting-minutes    { conversationId:探测用不存在id }          → 404 预期降级（不产生 AI 费用；
 *                          真实会话纪要会落库 FileRequirement/TodoItem，回归脚本不做写路径）
 *   /ai/explain-file       { fileRequirementId:真实可见条目优先 }      → 200 data.explanation 非空；
 *                          无可见条目时用不存在 id → 404 预期降级（零费用）
 *
 * 判定（每端点输出 状态|耗时|判定）:
 *   PASS(200)      正常返回且 data 结构非空
 *   PASS(4xx)      400/422 参数业务校验壳 / 404 预期不存在（记录为预期行为）/ 429 限流（探活达标）
 *   PASS(5xx降级)  503 AI_NOT_CONFIGURED / 504 AI_TIMEOUT / 502 AI_UPSTREAM* / AI_EMPTY 等设计内降级壳
 *                  （路由存活 + 统一 JSON 错误壳 = 优雅降级）
 *   FAIL           非 JSON 响应、500 未归类错误、单点耗时 ≥60s（超时失控）、Abort ≥90s、网络错误
 * 预算: 单点 AbortController 90s 上限；总预算 5 分钟（剩余不足时后续端点 SKIP）。
 *       服务端限流 30 次/5 分钟/用户，本脚本 ≤6 次不触顶。
 * 退出码: 0 = 无 FAIL；1 = 有 FAIL；2 = 环境错误。
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
const ENV_PATH = '/opt/pm-app/.env'
const TOTAL_BUDGET_MS = 5 * 60 * 1000 // 总预算 5 分钟
const PER_ENDPOINT_CAP_MS = 90 * 1000 // 单点 AbortController 90s 上限
const SOFT_TIMEOUT_MS = 60 * 1000 // 探活要求：单点可控 <60s，≥60s 判超时失控

// ── 认证（参照 scripts/e2e-full.mjs）─────────────────────────────────────────
const envText = (() => {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8')
  } catch {
    console.error(`FATAL: 无法读取 ${ENV_PATH}`)
    process.exit(2)
  }
})()
const envGet = (k) =>
  envText.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)?.trim()
const JWT_SECRET = envGet('JWT_SECRET')
if (!JWT_SECRET) {
  console.error('FATAL: .env 缺少 JWT_SECRET')
  process.exit(2)
}
const ADMIN = {
  userId: 'cmt7cdbzv001ov55otclrv94t',
  email: 'chenmuzhi@example.com',
  role: 'ADMIN',
}
const token = jwt.sign(ADMIN, JWT_SECRET, { expiresIn: '1h' })
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ── 计数 ────────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
let skip = 0
const clip = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

/** 设计内降级错误码（route 源码可查：AI 上游问题被归一为友好壳而非 500 崩溃） */
const AI_DEGRADE_CODES = new Set([
  'AI_NOT_CONFIGURED',
  'AI_TIMEOUT',
  'AI_UPSTREAM',
  'AI_UPSTREAM_ERROR',
  'AI_EMPTY',
  'AI_LOOP_LIMIT',
  'AI_BAD_MINUTES',
])

// ── 端点定义（最小合法载荷 + 200 时 data 结构断言）──────────────────────────
/** explain-file：优先取真实可见条目（真实 200 路径），取不到用不存在 id（404 预期降级，零费用） */
async function pickFileRequirementId() {
  try {
    const projRes = await fetch(`${BASE}/projects?limit=5`, { headers: H })
    const projJson = await projRes.json().catch(() => null)
    const proj = (projJson?.data?.items ?? []).find((p) => !p.isArchived) ?? projJson?.data?.items?.[0]
    if (proj?.id) {
      const frRes = await fetch(`${BASE}/file-requirements?projectId=${proj.id}&limit=5`, { headers: H })
      const frJson = await frRes.json().catch(() => null)
      const fr = (frJson?.data?.items ?? [])[0]
      if (fr?.id) return { id: fr.id, real: true, name: fr.name, project: proj.code ?? proj.name }
    }
  } catch {
    /* 采样失败走 404 探测路径 */
  }
  return { id: `qa-b2-probe-${Date.now()}`, real: false, name: null, project: null }
}

const endpoints = [
  {
    key: '/ai/chat',
    note: '全局助手·工具循环',
    payload: () => ({ messages: [{ role: 'user', content: '请只回复两个字：正常' }] }),
    okData: (d) => typeof d?.content === 'string' && d.content.trim().length > 0,
    detail: (d) => `content="${clip(d?.content, 30)}" toolsUsed=${JSON.stringify(d?.toolsUsed ?? [])}`,
  },
  {
    key: '/ai/autofill',
    note: '表单填充建议',
    payload: () => ({ context: '采购申请单', fields: ['title'], input: '采购2把十字螺丝刀' }),
    okData: (d) => d?.suggestions && typeof d.suggestions === 'object' && 'title' in d.suggestions,
    detail: (d) => `suggestions.title="${clip(d?.suggestions?.title, 30)}"`,
  },
  {
    key: '/ai/summarize',
    note: '数据汇总(type=mine)',
    payload: () => ({ type: 'mine' }),
    okData: (d) => (typeof d?.summary === 'string' && d.summary.trim().length > 0) || !!d?.stats,
    detail: (d) => `summary="${clip(d?.summary, 40)}" stats=${JSON.stringify(d?.stats ?? null)}`,
  },
  {
    key: '/ai/decompose-purchase',
    note: '采购清单分解(text)',
    payload: () => ({ text: '2把十字螺丝刀，3米BV2.5铜芯电线' }),
    okData: (d) => Array.isArray(d?.items) && d.items.length > 0,
    /** 200 + items 空 = 路由设计的软降级（"AI 未能解析出明细，请换更明确的描述"），单独记录 */
    softEmpty: (j) => j?.success === true && /未能解析|截断/.test(j?.message ?? ''),
    detail: (d) => `items=${d?.items?.length ?? 0} 首条=${JSON.stringify(d?.items?.[0] ?? null)}`,
  },
  {
    key: '/ai/meeting-minutes',
    note: '会话纪要（降级路径探测）',
    payload: () => ({ conversationId: `qa-b2-probe-${Date.now()}` }),
    expect404: '探测用不存在会话（真实纪要为落库写路径，回归脚本不做）',
    okData: null,
    detail: () => '',
  },
  {
    key: '/ai/explain-file',
    note: '文件条目解读',
    payload: null, // 运行时取真实/探测 id
    okData: (d) => typeof d?.explanation === 'string' && d.explanation.trim().length > 0,
    detail: (d) => `requirement=${clip(d?.requirement?.name, 24)} explanation="${clip(d?.explanation, 36)}"`,
  },
]

// ── 判定 ────────────────────────────────────────────────────────────────────
function judge(ep, { status, json, elapsed, aborted, abortAtMs }) {
  if (aborted) {
    return ['FAIL', `AbortController ${Math.round(abortAtMs / 1000)}s 截断（超 90s 上限，超时失控）`]
  }
  if (status === 0) return ['FAIL', `网络错误: ${json?.error ?? 'unknown'}`]
  if (json === null || typeof json !== 'object') return ['FAIL', `HTTP ${status} 非 JSON 响应（降级壳缺失）`]
  if (elapsed >= SOFT_TIMEOUT_MS) {
    return ['FAIL', `耗时 ${ (elapsed / 1000).toFixed(1) }s ≥60s（超时失控）`]
  }
  if (status === 200) {
    if (ep.okData && !ep.okData(json.data)) {
      // decompose-purchase 的空明细软降级：路由 200 + 明确提示 = 设计行为，记录为降级通过
      if (ep.softEmpty && ep.softEmpty(json)) {
        return ['PASS', `200 软降级 · ${clip(json.message, 40)}`]
      }
      return ['FAIL', `200 但 data 结构为空/不符 · ${clip(json.message, 40)}`]
    }
    return ['PASS', `200 OK · ${ep.detail ? clip(ep.detail(json.data), 70) : 'data 非空'}`]
  }
  if (status === 400 || status === 422) {
    return ['PASS', `${status} 参数/业务校验壳正常 · ${json.error?.code ?? ''} ${clip(json.message, 40)}`.trim()]
  }
  if (status === 404) {
    if (ep.expect404) return ['PASS', `404 预期降级 · ${json.error?.code ?? ''}（${ep.expect404}）`]
    return ['FAIL', `404 非预期 · ${clip(json.message, 50)}`]
  }
  if (status === 429) {
    return ['PASS', `429 限流壳正常（探活达标，未耗 AI 费用）· ${clip(json.message, 40)}`]
  }
  if (status >= 500) {
    const code = json.error?.code ?? ''
    if (AI_DEGRADE_CODES.has(code)) {
      return ['PASS', `${status} 设计内降级 · ${code} · ${clip(json.message, 40)}`]
    }
    return ['FAIL', `${status} 未归类服务端错误 · ${code} ${clip(json.message, 40)}`]
  }
  return ['FAIL', `HTTP ${status} ${clip(json.message, 40)}`]
}

// ── 执行 ────────────────────────────────────────────────────────────────────
const t0 = Date.now()
const rows = [] // { key, status, elapsed, verdict, note }
let spent = 0

console.log(`QA B2a-2 AI功能链 e2e  |  BASE=${BASE}  |  ADMIN=${ADMIN.email}`)
console.log(`预算: 单点≤${PER_ENDPOINT_CAP_MS / 1000}s(Abort)，软超时<${SOFT_TIMEOUT_MS / 1000}s，总≤${TOTAL_BUDGET_MS / 60000}分钟\n`)

for (const ep of endpoints) {
  const remain = TOTAL_BUDGET_MS - spent
  if (remain < 15 * 1000) {
    skip++
    rows.push({ key: ep.key, status: '-', elapsed: 0, verdict: 'SKIP', note: `总预算仅剩 ${(remain / 1000).toFixed(0)}s` })
    console.log(`⏭️ SKIP  ${ep.key}  → 总预算仅剩 ${(remain / 1000).toFixed(0)}s`)
    continue
  }

  // 载荷（explain-file 先采样真实条目 id）
  let payload
  let probeNote = ''
  if (ep.payload) {
    payload = ep.payload()
  } else {
    const pick = await pickFileRequirementId()
    payload = { fileRequirementId: pick.id }
    probeNote = pick.real ? `真实条目「${pick.name}」@${pick.project}` : '无可见条目→探测 id（预期 404）'
  }

  const ctl = new AbortController()
  const cap = Math.min(PER_ENDPOINT_CAP_MS, remain)
  let abortAtMs = cap
  const timer = setTimeout(() => ctl.abort(), cap)
  const s0 = Date.now()
  let status = 0
  let json = null
  let aborted = false
  let netErr = null
  try {
    const res = await fetch(`${BASE}${ep.key}`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
    status = res.status
    json = await res.json().catch(() => null)
  } catch (e) {
    if (e?.name === 'AbortError') aborted = true
    else netErr = String(e?.message ?? e)
  } finally {
    clearTimeout(timer)
  }
  const elapsed = Date.now() - s0
  spent += elapsed

  if (netErr) json = { error: netErr }
  if (aborted) abortAtMs = elapsed
  const [verdict, note] = judge(ep, { status, json, elapsed, aborted, abortAtMs })
  if (verdict === 'PASS') pass++
  else if (verdict === 'FAIL') fail++
  rows.push({ key: ep.key, status: aborted ? 'ABORT' : status, elapsed, verdict, note })

  const tag = verdict === 'PASS' ? '✅' : '❌'
  console.log(
    `${tag} ${verdict.padEnd(4)} ${ep.key.padEnd(22)} ${String(status === 0 && netErr ? 'ERR' : status).padStart(3)} | ${(elapsed / 1000).toFixed(1).padStart(5)}s | ${note}${probeNote ? `  ｜载荷: ${probeNote}` : ''}`,
  )
}

// ── 汇总表 ──────────────────────────────────────────────────────────────────
const total = pass + fail + skip
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n━━━ AI 端点 状态|耗时|判定 明细 ━━━`)
for (const r of rows) {
  console.log(
    `${r.key.padEnd(22)} ${String(r.status).padStart(5)} | ${(r.elapsed / 1000).toFixed(1).padStart(5)}s | ${r.verdict}  ${r.note}`,
  )
}
console.log(`\n━━━ 汇总: ${total} 端点 = PASS ${pass} / FAIL ${fail} / SKIP ${skip}  |  总耗时 ${secs}s（预算 ${(TOTAL_BUDGET_MS / 60000).toFixed(0)} 分钟）━━━`)
process.exit(fail === 0 ? 0 : 1)
