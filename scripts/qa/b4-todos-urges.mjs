#!/usr/bin/env node
/**
 * QA B4 e2e —— /todos 待办中心 + 催办跳转数据链路（只读 + 自建自删）
 *
 * 覆盖:
 *   1. POST /todos 建一条 link=/projects 的待办（ADMIN 本人 userId）
 *   2. GET /todos?done=0 含它（link 透传）
 *   3. PATCH /todos/:id {done:true} → GET /todos?done=1 含它
 *   4. DELETE /todos/:id（删除 API 存在性验证 + 清理）
 *   5. GET /urges/mine → incoming/outgoing/recentlyDone 字段含 projectId/requirementId
 *   6. POST /todos link=http://外部 → 400（QA B4 修4 白名单）
 *   7. GET /todos 页面 200 冒烟
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = 'http://127.0.0.1:3001'
const envText = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const envGet = (k) =>
  envText.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)?.trim()
const JWT_SECRET = envGet('JWT_SECRET')
const ADMIN = {
  userId: 'cmt7cdbzv001ov55otclrv94t',
  email: 'chenmuzhi@example.com',
  role: 'ADMIN',
}
const token = jwt.sign(ADMIN, JWT_SECRET, { expiresIn: '1h' })
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`)
  if (!cond) failed++
}

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json }
}

// ── 1–4. 待办生命周期（建→查→PATCH→DELETE）；try/finally 兜底，中途任一步
//    断言失败/抛错也不残留测试待办（finally 按标题标记扫 done=0/1，仍在则 DELETE） ──
const MARK = `QA-B4-e2e-${Date.now()}`
try {
  // ── 1. 建待办 link=/projects ──
  const created = await api('POST', '/todos', {
    title: `【${MARK}】自建测试待办`,
    link: '/projects',
    priority: 'HIGH',
  })
  check('POST /todos 建待办(link=/projects)', created.status === 201, `status=${created.status}`)
  const todoId = created.json?.data?.id
  check('  返回 id + link 透传', !!todoId && created.json?.data?.link === '/projects')

  // ── 2. done=0 含它 ──
  const undone = await api('GET', '/todos?done=0')
  const found0 = (undone.json?.data ?? []).find((t) => t.id === todoId)
  check('GET /todos?done=0 含新建待办', undone.status === 200 && !!found0, `title=${found0?.title}`)

  // ── 3. PATCH 完成 → done=1 含它 ──
  const patched = await api('PATCH', `/todos/${todoId}`, { done: true })
  check('PATCH /todos/:id {done:true}', patched.status === 200, `status=${patched.status}`)
  const doneList = await api('GET', '/todos?done=1')
  const found1 = (doneList.json?.data ?? []).find((t) => t.id === todoId)
  check('GET /todos?done=1 含已完成待办', doneList.status === 200 && !!found1, `doneAt=${found1?.doneAt}`)

  // ── 4. DELETE 存在性 + 清理 ──
  const deleted = await api('DELETE', `/todos/${todoId}`)
  check('DELETE /todos/:id（API 存在，可物理删除）', deleted.status === 200, `status=${deleted.status}`)
  const afterDel = await api('GET', `/todos?done=0`)
  const gone = !(afterDel.json?.data ?? []).some((t) => t.id === todoId)
  check('  删除后 done=0 不再含它', gone)
} finally {
  // 兑底清理：若测试待办仍存在（按标题标记 MARK 扫 done=0/1）则 DELETE，不留脏数据
  try {
    const leftovers = []
    for (const done of [0, 1]) {
      const list = await api('GET', `/todos?done=${done}&limit=1000`)
      leftovers.push(...(list.json?.data ?? []).filter((t) => (t.title ?? '').includes(MARK)))
    }
    for (const t of leftovers) await api('DELETE', `/todos/${t.id}`)
    if (leftovers.length > 0) console.log(`🧹 兑底清理 ${leftovers.length} 条残留测试待办（【${MARK}】）`)
  } catch {}
}

// ── 5. /urges/mine 字段完整性 ──
const urges = await api('GET', '/urges/mine')
const d = urges.json?.data ?? {}
const inHasFields = (d.incoming ?? []).every((u) => 'projectId' in u && 'requirementId' in u)
const outHasFields = (d.outgoing ?? []).every((u) => 'projectId' in u && 'requirementId' in u)
check(
  'GET /urges/mine 正常返回',
  urges.status === 200 && Array.isArray(d.incoming) && Array.isArray(d.outgoing),
  `incoming=${d.incomingCount} outgoing=${d.outgoingCount} recentlyDone=${(d.recentlyDone ?? []).length}`,
)
check(
  '  incoming/outgoing 行含 projectId+requirementId（跳转字段）',
  inHasFields && outHasFields,
  `incoming样本: ${d.incoming?.[0] ? `${d.incoming[0].projectId}/${d.incoming[0].requirementId}` : '空数组(字段检查按全称通过)'}`,
)

// ── 6. 修4：link 白名单（外部链接 400） ──
const evil = await api('POST', '/todos', { title: `【${MARK}】外链`, link: 'http://evil.example.com' })
if (evil.status === 201) {
  // 反向断言失败（白名单失效，外链被建成）：先删掉刚建的 evil 待办再判 FAIL，不留脏数据
  const evilId = evil.json?.data?.id
  if (evilId) {
    await api('DELETE', `/todos/${evilId}`)
    console.log(`🧹 已清理白名单失效时误建的 evil 待办（${evilId}）`)
  }
}
check('POST /todos link=http://外链 被拒(400)', evil.status === 400, `status=${evil.status} msg=${evil.json?.error?.message ?? ''}`)

// ── 7. /todos 页面冒烟（SSR 200 + 壳完整） ──
const page = await fetch(`${BASE}/todos`)
const html = await page.text()
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '')
check(
  'GET /todos 页面 200 且无客户端错误壳',
  page.status === 200 && !visible.includes('Application error'),
  `status=${page.status}`,
)

console.log(failed === 0 ? '\n🎉 全部通过' : `\n💥 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
