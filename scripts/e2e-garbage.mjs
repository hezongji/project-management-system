import jwt from 'jsonwebtoken'
import fs from 'fs'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const token = jwt.sign({ userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }, get('JWT_SECRET'), { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
// 全部是乱码/无法识别的行
const garbage = [
  ['@@@', '###', '$$$'],
  ['----', '====', '....'],
  ['xxx'],
]
const t0 = Date.now()
const r = await fetch('http://127.0.0.1:3001/api/ai/decompose-purchase', {
  method: 'POST', headers: H, body: JSON.stringify({ mode: 'excel', rows: garbage }),
})
const j = await r.json()
console.log(`garbage: ${r.status} in ${((Date.now()-t0)/1000).toFixed(1)}s`)
console.log(JSON.stringify(j).slice(0, 400))
