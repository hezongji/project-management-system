// W4 接口自测：文件移动 + 列表端点
// 用法: node scripts/w4-file-move-test.mjs
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = process.env.BASE || 'http://127.0.0.1:3101'
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }
const token = jwt.sign(ADMIN, SECRET, { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

// 测试素材
const PROJ_A = 'cmt7cdc9y0061v55oq7f3rgws' // 示例客户05增补（非归档）
const CAT_A1 = 'cmt7cdfar04krv578sscyt0gb' // 01-商务拜访
const CAT_A2 = 'cmt7cdfat04kxv578o08axmvv' // 02-方案设计
const PROJ_B = 'cmt7cdca30065v55o9f84mrra' // 江南示范产线一期
const CAT_B1 = 'cmt7cdfi504y5v57827no3bwq'
const ENTRY_FILE = 'cmt7d8s62026xv5rk6k4k40oh' // 条目文件（requirementId 非空）

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`) }

async function uploadAdhoc(catalogId, name) {
  const buf = Buffer.from(`W4 test file ${name} ${Date.now()}`)
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'text/plain' }), name)
  fd.append('catalogId', catalogId)
  const r = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const j = await r.json()
  return { status: r.status, file: j?.data?.file, body: j }
}

// ── 1. 上传计划外文件到 A1 ──
const up1 = await uploadAdhoc(CAT_A1, 'w4-move-test-1.txt')
ok('上传计划外文件 A1', up1.status === 201, `HTTP ${up1.status}`)
const fileA = up1.file
if (!fileA) { console.log('上传失败，终止'); process.exit(1) }

// ── 2. 列表端点：A1 下能看到 ──
const rList1 = await fetch(`${BASE}/api/files?projectId=${PROJ_A}&catalogId=${CAT_A1}`, { headers: H })
const list1 = await rList1.json()
ok('GET /api/files 列出 A1 计划外文件', rList1.status === 200 && (list1.data?.items ?? []).some((f) => f.id === fileA.id), `HTTP ${rList1.status}`)

// ── 3. move 到 A2 → 成功 ──
const rMove = await fetch(`${BASE}/api/files/${fileA.id}/move`, { method: 'PATCH', headers: H, body: JSON.stringify({ catalogId: CAT_A2 }) })
const jMove = await rMove.json()
ok('move A1→A2 成功', rMove.status === 200, `HTTP ${rMove.status} ${JSON.stringify(jMove?.message ?? jMove?.error?.message ?? '')}`)
const movedPath = jMove?.data?.file?.storagePath
ok('storagePath 已更新为 A2 前缀', typeof movedPath === 'string' && movedPath.startsWith(`${PROJ_A}/${CAT_A2}/`), movedPath)

// ── 4. 移动后旧目录列表为空、新目录可见 ──
const rListOld = await fetch(`${BASE}/api/files?projectId=${PROJ_A}&catalogId=${CAT_A1}`, { headers: H })
const listOld = await rListOld.json()
ok('A1 列表不再包含该文件', !(listOld.data?.items ?? []).some((f) => f.id === fileA.id))
const rListNew = await fetch(`${BASE}/api/files?projectId=${PROJ_A}&catalogId=${CAT_A2}`, { headers: H })
const listNew = await rListNew.json()
ok('A2 列表包含该文件', (listNew.data?.items ?? []).some((f) => f.id === fileA.id))

// ── 5. 下载端点 200（移动后磁盘可读）──
const rDl = await fetch(`${BASE}/api/files/${fileA.id}/download`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' })
ok('移动后下载 200', rDl.status === 200, `HTTP ${rDl.status}`)

// ── 6. 跨项目 move → 400 ──
const rCross = await fetch(`${BASE}/api/files/${fileA.id}/move`, { method: 'PATCH', headers: H, body: JSON.stringify({ catalogId: CAT_B1 }) })
ok('跨项目 move 400', rCross.status === 400, `HTTP ${rCross.status} ${JSON.stringify((await rCross.json())?.error?.message ?? '')}`)

// ── 7. 条目文件 move → 400 ──
const rEntry = await fetch(`${BASE}/api/files/${ENTRY_FILE}/move`, { method: 'PATCH', headers: H, body: JSON.stringify({ catalogId: CAT_A1 }) })
ok('条目文件 move 400', rEntry.status === 400, `HTTP ${rEntry.status} ${JSON.stringify((await rEntry.json())?.error?.message ?? '')}`)

// ── 8. 权限：无 token → 401 ──
const rNoAuth = await fetch(`${BASE}/api/files/${fileA.id}/move`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ catalogId: CAT_A2 }) })
ok('无 token 401', rNoAuth.status === 401, `HTTP ${rNoAuth.status}`)

// ── 9. 重复 move 到当前目录（幂等/同目录）→ 允许（同项目同目录，rename 同路径）──
const rSame = await fetch(`${BASE}/api/files/${fileA.id}/move`, { method: 'PATCH', headers: H, body: JSON.stringify({ catalogId: CAT_A2 }) })
ok('move 到同目录（幂等）200 或 409', rSame.status === 200 || rSame.status === 409, `HTTP ${rSame.status}`)

// ── 清理：删除测试文件 ──
const rDel = await fetch(`${BASE}/api/files/${fileA.id}`, { method: 'DELETE', headers: H })
ok('清理测试文件', rDel.status === 200 || rDel.status === 204, `HTTP ${rDel.status}`)

console.log(`\n汇总: ${pass}/${pass + fail} PASS`)
process.exit(fail ? 1 : 0)
