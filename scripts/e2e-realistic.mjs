// 完整链路复现：真实 xlsx（前端同款解析）→ decompose → ai-import
import jwt from 'jsonwebtoken'
import fs from 'fs'
import * as XLSX from 'xlsx'

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const token = jwt.sign(
  { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' },
  get('JWT_SECRET'),
  { expiresIn: '1h' }
)
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

// 与前端完全一致的解析逻辑
const buf = fs.readFileSync('/tmp/realistic-purchase.xlsx')
const wb = XLSX.read(buf, { type: 'buffer' })
const ws = wb.Sheets[wb.SheetNames[0]]
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
const matrix = aoa.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c !== ''))
console.log('matrix rows:', matrix.length, JSON.stringify(matrix.slice(0, 3)))

const t0 = Date.now()
const r1 = await fetch(`${BASE}/ai/decompose-purchase`, {
  method: 'POST', headers: H, body: JSON.stringify({ mode: 'excel', rows: matrix }),
})
const j1 = await r1.json()
console.log(`STEP1 decompose: ${r1.status} in ${Date.now() - t0}ms`, JSON.stringify(j1).slice(0, 800))
if (!j1.success) process.exit(1)

const rows = j1.data.items.map((it) => ({
  name: it.name, spec: it.spec || null, param: it.param || null,
  unit: it.unit || '件', quantity: it.quantity ?? 1,
  brand: it.brand || null, remark: it.remark || null,
}))
const t1 = Date.now()
const r2 = await fetch(`${BASE}/purchase-requests/ai-import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ projectId: 'cmt7cdc9y0061v55oq7f3rgws', title: 'TEST-AI-IMPORT-E2E', rows }),
})
const j2 = await r2.json()
console.log(`STEP2 ai-import: ${r2.status} in ${Date.now() - t1}ms`, JSON.stringify(j2).slice(0, 1200))
if (j2.success) fs.writeFileSync('/tmp/e2e-result.json', JSON.stringify(j2, null, 2))
