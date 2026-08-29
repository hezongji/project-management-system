// 200行大清单压力测试：验证 AI 超时/重试/容错
import jwt from 'jsonwebtoken'
import fs from 'fs'
const BASE = process.env.BASE || 'http://127.0.0.1:3001/api'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const token = jwt.sign(
  { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' },
  get('JWT_SECRET'), { expiresIn: '1h' }
)
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
const matrix = [['序号', '物料名称', '规格型号', '数量', '单位', '品牌', '备注']]
for (let i = 1; i <= 199; i++) {
  matrix.push([i, `物料${i}`, `型号X${i}`, String(i % 50 + 1), '个', i % 3 === 0 ? '西门子' : i % 3 === 1 ? '施耐德' : 'ABB', ''])
}
const t0 = Date.now()
const r = await fetch(`${BASE}/ai/decompose-purchase`, {
  method: 'POST', headers: H, body: JSON.stringify({ mode: 'excel', rows: matrix }),
})
const j = await r.json()
console.log(`decompose: ${r.status} in ${((Date.now() - t0)/1000).toFixed(1)}s | items=${j.data?.items?.length} msg=${j.message}`)
if (j.success) console.log('sample:', JSON.stringify(j.data.items[0]), '...', JSON.stringify(j.data.items[j.data.items.length-1]))
