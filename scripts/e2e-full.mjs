// 完整链路 E2E：真实 xlsx → decompose（分块）→ ai-import（含供应商指定 → 生成订单）
// 供应商匹配：前端逻辑 matchSupplierByName（名称互相包含）
import jwt from 'jsonwebtoken'
import fs from 'fs'
import * as XLSX from 'xlsx'

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const token = jwt.sign(
  { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' },
  get('JWT_SECRET'), { expiresIn: '1h' }
)
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

// 1) 前端同款 xlsx 解析
const buf = fs.readFileSync('/tmp/realistic-purchase.xlsx')
const wb = XLSX.read(buf, { type: 'buffer' })
const ws = wb.Sheets[wb.SheetNames[0]]
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
const matrix = aoa.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c !== ''))
console.log('matrix:', matrix.length, 'rows')

// 2) AI 供应商建议（模拟前端 matchSupplierByName）
const SUPPLIERS = await fetch(`${BASE}/external-orgs?type=SUPPLIER&limit=200`, { headers: H }).then((r) => r.json()).then((r) => r.data?.items ?? [])
const match = (name) => { const n = (name ?? '').trim(); return n ? SUPPLIERS.find((s) => s.name.includes(n) || n.includes(s.name)) : undefined }

const t0 = Date.now()
const r1 = await fetch(`${BASE}/ai/decompose-purchase`, {
  method: 'POST', headers: H, body: JSON.stringify({ mode: 'excel', rows: matrix }),
})
const j1 = await r1.json()
console.log(`STEP1 decompose: ${r1.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s | items=${j1.data?.items?.length} warnings=${j1.data?.warnings?.length ?? 0}`)
if (!j1.success || !j1.data?.items?.length) { console.log('FAIL at step1:', JSON.stringify(j1).slice(0, 500)); process.exit(1) }

// 3) 品牌 → 供应商 建议（与前端一致）
const brandSupplier = {}
for (const it of j1.data.items) {
  const b = (it.brand || '').trim() || '待分配'
  if (!brandSupplier[b]) {
    const hint = it.supplierName || (b !== '待分配' ? b : '')
    const hit = hint ? match(hint) : undefined
    if (hit) brandSupplier[b] = hit.id
  }
}
console.log('brand->supplier:', JSON.stringify(brandSupplier))

const rows = j1.data.items.map((it) => ({
  name: it.name, spec: it.spec || null, param: it.param || null,
  unit: it.unit || '件', quantity: it.quantity ?? 1,
  brand: it.brand || null, remark: it.remark || null,
  supplierId: brandSupplier[(it.brand || '').trim() || '待分配'] || null,
}))
const t1 = Date.now()
const r2 = await fetch(`${BASE}/purchase-requests/ai-import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ projectId: 'cmt7cdc9y0061v55oq7f3rgws', title: 'TEST-AI-FULL-E2E', rows }),
})
const j2 = await r2.json()
console.log(`STEP2 ai-import: ${r2.status} in ${Date.now() - t1}ms | orders=${j2.data?.orders?.length} pending=${j2.data?.pendingSrs?.length}`)
console.log(JSON.stringify(j2).slice(0, 1000))
if (j2.success) fs.writeFileSync('/tmp/e2e-full-result.json', JSON.stringify(j2, null, 2))
