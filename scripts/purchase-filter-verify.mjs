/**
 * 采购管理页筛选接线验证（三 Tab × 筛选维度 API 实测）
 *
 * 背景：页面级筛选（项目/状态/类别/供应商）原先只有采购订单 Tab 接了查询参数；
 *      本次修复把采购清单（/purchase-requests）与供应商需求（/supplier-requests）
 *      两个 Tab 也接上，后端补齐两处 category 过滤。
 *
 * 验证模式（参照订单 Tab 已验证模式：/purchase-orders?projectId=X → total 13→3 且 allMatch）：
 *   每个 API × 每个维度：不带参 total0 → 从真实数据取一个值带参 → 断言 total 变化
 *   且返回记录该字段全部匹配；样本覆盖全量时额外断言 total1 === 该值在库内精确计数。
 *   特别断言新参数：/purchase-requests?category=、/supplier-requests?category=、
 *   /supplier-requests?supplierId=（supplierId 可空，= 过滤只匹配已绑定该供应商的记录）。
 *
 * 用法：node scripts/purchase-filter-verify.mjs
 *      BASE=https://pm.hezongji.cn/api node scripts/purchase-filter-verify.mjs   （线上）
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const get = (k) =>
  env
    .split('\n')
    .find((l) => l.startsWith(k + '='))
    ?.slice(k.length + 1)
    ?.trim()
const token = jwt.sign(
  { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' },
  get('JWT_SECRET'),
  { expiresIn: '1h' },
)
const H = { Authorization: `Bearer ${token}` }

async function api(path, params = {}) {
  const qs = new URLSearchParams({ limit: '100', ...params }).toString()
  const r = await fetch(`${BASE}${path}?${qs}`, { headers: H })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j?.success) {
    throw new Error(`${path}?${qs} → HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`)
  }
  return { items: j.data.items ?? [], total: j.data.pagination?.total ?? 0 }
}

const lines = []
let failCount = 0
const emit = (status, msg) => {
  const mark = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ '
  if (status === 'FAIL') failCount += 1
  lines.push(`${mark} ${status.padEnd(4)} ${msg}`)
  console.log(`${mark} ${status.padEnd(4)} ${msg}`)
}

/** 单维度实测：tab 标签 / path / 查询参数名 / 从响应项提取该维度值的取值器 */
async function checkDim(tab, path, param, pick) {
  try {
    const { items: sample } = await api(path) // limit=100 样本
    const base = await api(path, { limit: '1' }) // total0（全量计数）
    const dist = new Map()
    for (const it of sample) {
      const v = pick(it)
      if (v != null && v !== '') dist.set(v, (dist.get(v) ?? 0) + 1)
    }
    if (dist.size === 0) {
      emit('WARN', `${tab} ${path} ${param}= 样本无可用取值（该维度数据为空），跳过`)
      return
    }
    // 取值策略：多值时选计数最小（收缩最明显）且必然 strict subset 的值；单值时全库同值
    const chosen =
      dist.size >= 2
        ? [...dist.entries()].sort((a, b) => a[1] - b[1])[0][0]
        : [...dist.keys()][0]
    const exactKnown = base.total <= 100 // 样本即全量 → 计数可精确断言
    const { items, total } = await api(path, { [param]: chosen })
    const allMatch = items.length > 0 && items.every((it) => pick(it) === chosen)
    const shrinkOk = dist.size >= 2 ? total < base.total : true
    const exactOk = exactKnown ? total === dist.get(chosen) : true
    const valueLabel = String(chosen).slice(0, 24)
    const bits = [
      `${tab} ${path}?${param}=${valueLabel}`,
      `total ${base.total} → ${total}`,
      `allMatch=${allMatch}`,
      exactKnown ? `exactCount=${exactOk}` : null,
      dist.size < 2 ? '（全库同值，无收缩空间）' : null,
    ].filter(Boolean)
    if (!allMatch || !shrinkOk || !exactOk || total === 0) {
      emit('FAIL', bits.join(' | '))
    } else if (!shrinkOk) {
      emit('WARN', bits.join(' | '))
    } else {
      emit('PASS', bits.join(' | '))
    }
  } catch (e) {
    emit('FAIL', `${tab} ${path} ${param} 异常: ${e.message}`)
  }
}

// ─────────────────── 1) 三 Tab × 各自维度实测 ───────────────────

// Tab1 采购订单：四维（已接线的基线复验）
await checkDim('订单', '/purchase-orders', 'projectId', (it) => it.project?.id)
await checkDim('订单', '/purchase-orders', 'status', (it) => it.status)
await checkDim('订单', '/purchase-orders', 'category', (it) => it.category)
await checkDim('订单', '/purchase-orders', 'supplierId', (it) => it.supplier?.id)

// Tab2 采购清单：项目/状态/类别（本次接线 + 后端补 category）
await checkDim('清单', '/purchase-requests', 'projectId', (it) => it.project?.id)
await checkDim('清单', '/purchase-requests', 'status', (it) => it.status)
await checkDim('清单', '/purchase-requests', 'category', (it) => it.category)

// Tab3 供应商需求：项目/状态/类别/供应商（本次接线 + 后端补 category）
await checkDim('供需', '/supplier-requests', 'projectId', (it) => it.project?.id)
await checkDim('供需', '/supplier-requests', 'status', (it) => it.status)
await checkDim('供需', '/supplier-requests', 'category', (it) => it.category)
await checkDim('供需', '/supplier-requests', 'supplierId', (it) => it.supplier?.id)

// ─────────────── 2) 新参数专项断言（后端本次补齐/重点验证项） ───────────────

async function assertParam(path, param, wanted, fallbackPicker) {
  try {
    const base = await api(path, { limit: '1' })
    const probe = await api(path, { [param]: wanted, limit: '100' })
    // 首选值无数据时回退到库内真实存在的值（仍验证参数生效本身）
    let value = wanted
    let { items, total } = probe
    if (total === 0 && fallbackPicker) {
      const { items: sample } = await api(path)
      const v = fallbackPicker(sample)
      if (v) {
        value = v
        ;({ items, total } = await api(path, { [param]: value }))
      }
    }
    const pick =
      param === 'supplierId' ? (it) => it.supplier?.id : param === 'projectId' ? (it) => it.project?.id : (it) => it[param]
    const allMatch = items.every((it) => pick(it) === value)
    const usedFallback = value !== wanted
    const ok = total > 0 && allMatch && (usedFallback || total < base.total || base.total === total)
    emit(ok ? 'PASS' : 'FAIL', [
      `专项 ${path}?${param}=${String(value).slice(0, 24)}${usedFallback ? `（首选 ${wanted} 无数据，回退真实值）` : ''}`,
      `total ${base.total} → ${total}`,
      `allMatch=${allMatch}`,
    ].join(' | '))
  } catch (e) {
    emit('FAIL', `专项 ${path} ${param} 异常: ${e.message}`)
  }
}

await assertParam('/purchase-requests', 'category', 'MECHANICAL', (sample) =>
  sample.find((it) => it.category)?.category,
)
await assertParam('/supplier-requests', 'category', 'ELECTRICAL', (sample) =>
  sample.find((it) => it.category)?.category,
)
// supplierId 专项：先从库内取真实已绑定供应商的 id（后端 = 过滤只匹配已绑定记录，可空记录不命中）
{
  const { items: srSample } = await api('/supplier-requests')
  const sid = srSample.find((it) => it.supplier?.id)?.supplier?.id
  if (sid) await assertParam('/supplier-requests', 'supplierId', sid)
  else emit('WARN', '专项 /supplier-requests?supplierId= 库内无已绑定供应商的记录，跳过')
}

// ─────────────────── 3) 汇总 ───────────────────
console.log('\n────────── 汇总 ──────────')
console.log(`BASE: ${BASE}`)
console.log(lines.filter((l) => l.includes('❌')).length === 0 ? '全部通过 ✅' : `存在失败项 ❌（共 ${failCount} 项）`)
process.exit(failCount > 0 ? 1 : 0)
