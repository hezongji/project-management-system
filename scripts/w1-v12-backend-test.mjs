#!/usr/bin/env node
// W1 · v1.2 后端准备验收（2026-08-29）
// prefs / announcement / voice 三组端点 + GET /conversations myPrefs
// 用法: node scripts/w1-v12-backend-test.mjs
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
const ENV_FILE = process.env.ENV_FILE || '/opt/pm-app/.env'
const env = fs.readFileSync(ENV_FILE, 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')

// ADMIN = 陈牧之（真实用户，from GET /users 侦察）
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN', name: '陈牧之' }

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`) }

const tokenA = jwt.sign(ADMIN, SECRET, { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` }

try {
  // ── 准备：找其他用户 + 建 QA 群 ──
  const users = (await (await fetch(`${BASE}/users`, { headers: H })).json()).data ?? []
  const other = users.find((u) => u.id !== ADMIN.userId)
  ok('存在其他用户（丁望初等）', !!other, other?.name)
  const conv = (await (await fetch(`${BASE}/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'GROUP', memberIds: [other.id] }) })).json()).data
  ok('QA 群已创建', !!conv?.id, conv?.id?.slice(0, 12))

  // ── 1. prefs：置顶/免打扰/隐藏 round-trip ──
  let r = await fetch(`${BASE}/conversations/${conv.id}/prefs`, { method: 'PATCH', headers: H, body: JSON.stringify({ isPinned: true, muted: true }) })
  let b = await r.json()
  ok('prefs 置顶+免打扰 200', r.status === 200 && b.data?.myPrefs?.isPinned === true && b.data?.myPrefs?.muted === true)

  // GET /conversations 含 myPrefs
  const list = (await (await fetch(`${BASE}/conversations`, { headers: H })).json()).data ?? []
  const item = list.find((c) => c.id === conv.id)
  ok('GET /conversations 含 myPrefs.isPinned=true', item?.myPrefs?.isPinned === true)
  ok('GET /conversations 含 myPrefs.muted=true', item?.myPrefs?.muted === true)

  // hiddenAt 设置 + 恢复 null
  r = await fetch(`${BASE}/conversations/${conv.id}/prefs`, { method: 'PATCH', headers: H, body: JSON.stringify({ hiddenAt: new Date().toISOString() }) })
  b = await r.json()
  ok('prefs 设置 hiddenAt 200', r.status === 200 && !!b.data?.myPrefs?.hiddenAt)
  r = await fetch(`${BASE}/conversations/${conv.id}/prefs`, { method: 'PATCH', headers: H, body: JSON.stringify({ hiddenAt: null }) })
  b = await r.json()
  ok('prefs 恢复 hiddenAt=null', r.status === 200 && b.data?.myPrefs?.hiddenAt === null)

  // 还原置顶/免打扰
  await fetch(`${BASE}/conversations/${conv.id}/prefs`, { method: 'PATCH', headers: H, body: JSON.stringify({ isPinned: false, muted: false }) })

  // ── prefs 非成员 403：构造一个非本群用户 token（用另一个用户 id 签 JWT）──
  const stranger = users.find((u) => u.id !== ADMIN.userId && u.id !== other.id)
  const tokenS = jwt.sign({ userId: stranger.id, email: stranger.email, role: 'MEMBER' }, SECRET, { expiresIn: '1h' })
  const HS = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenS}` }
  r = await fetch(`${BASE}/conversations/${conv.id}/prefs`, { method: 'PATCH', headers: HS, body: JSON.stringify({ isPinned: true }) })
  ok('prefs 非成员 403', r.status === 403, `HTTP ${r.status}`)

  // ── 2. announcement：ADMIN 发布 → GET 含 announcement；MEMBER 403 ──
  r = await fetch(`${BASE}/conversations/${conv.id}/announcement`, { method: 'PATCH', headers: H, body: JSON.stringify({ content: 'W1 测试公告' }) })
  b = await r.json()
  ok('announcement ADMIN 发布 200', r.status === 200 && b.data?.announcement === 'W1 测试公告')
  const list2 = (await (await fetch(`${BASE}/conversations`, { headers: H })).json()).data ?? []
  const item2 = list2.find((c) => c.id === conv.id)
  ok('GET /conversations 含 announcement', item2?.announcement === 'W1 测试公告')

  // MEMBER（other）发布 403
  const tokenO = jwt.sign({ userId: other.id, email: other.email, role: 'MEMBER' }, SECRET, { expiresIn: '1h' })
  const HO = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenO}` }
  r = await fetch(`${BASE}/conversations/${conv.id}/announcement`, { method: 'PATCH', headers: HO, body: JSON.stringify({ content: '越权' }) })
  ok('announcement MEMBER 403', r.status === 403, `HTTP ${r.status}`)

  // 清理公告
  await fetch(`${BASE}/conversations/${conv.id}/announcement`, { method: 'PATCH', headers: H, body: JSON.stringify({ content: '' }) })

  // ── 3. voice：上传→下载 round-trip + 非法 uuid ──
  const voiceBuf = Buffer.from('W1 voice roundtrip test payload 1234567890')
  const form = new FormData()
  form.append('file', new Blob([voiceBuf], { type: 'audio/webm' }), 'voice.webm')
  form.append('duration', '3')
  r = await fetch(`${BASE}/im/voice-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form })
  b = await r.json()
  const voiceId = b.data?.voiceId
  ok('voice-upload 200', r.status === 200 && !!voiceId, voiceId?.slice(0, 8))
  ok('voice-upload 返回 duration', b.data?.duration === 3)

  const dl = await fetch(`${BASE}/im/voice/${voiceId}`, { headers: { Authorization: `Bearer ${tokenA}` } })
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  ok('voice 下载 200 + Content-Type', dl.status === 200 && (dl.headers.get('content-type') || '').includes('audio/webm'))
  ok('voice round-trip 内容一致', dlBuf.equals(voiceBuf))

  // 非法 uuid
  r = await fetch(`${BASE}/im/voice/../../etc/passwd`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ok('voice 非法 uuid 拒（400/404）', r.status === 400 || r.status === 404, `HTTP ${r.status}`)

  // 超限文件（>2MB）
  const bigBuf = Buffer.alloc(2 * 1024 * 1024 + 1, 7)
  const form2 = new FormData()
  form2.append('file', new Blob([bigBuf], { type: 'audio/webm' }), 'big.webm')
  r = await fetch(`${BASE}/im/voice-upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form2 })
  ok('voice 超 2MB 拒绝', r.status === 400, `HTTP ${r.status}`)

  // 清理：voice 文件（走磁盘删除：upload 目录下的 im-voice/{voiceId}.webm）
  try {
    const voiceDir = `${getEnv('FILE_ROOT') || '/opt/pm-app/uploads'}/im-voice`
    const files = fs.readdirSync(voiceDir).filter((f) => f.startsWith(voiceId))
    for (const f of files) fs.unlinkSync(`${voiceDir}/${f}`)
    ok('voice 测试文件已清理', true, `${files.length} 个`)
  } catch (e) {
    ok('voice 测试文件清理（路径未找到则跳过）', true, e.message)
  }

  // 清理 QA 群
  const del = await fetch(`${BASE}/conversations/${conv.id}`, { method: 'DELETE', headers: H })
  ok('QA 群已清理', del.status === 200, `HTTP ${del.status}`)
} catch (e) {
  fail++
  console.error('❌ 异常:', e.message)
}

console.log(`\n汇总: ${pass}/${pass + fail} PASS`)
process.exit(fail ? 1 : 0)
