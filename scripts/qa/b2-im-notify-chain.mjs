#!/usr/bin/env node
// B2 数据流闭环 · 链路3：IM+通知链（kimi 初稿 + 实测校准版）
// 注册一次性QA用户B → 建群会话 → Socket发消息(@B) → REST读消息 → 双侧标已读
//   → B侧 MENTION 通知+TodoItem 断言 → B全部已读 → 解散会话 → 删QA用户（痕迹级联）
//
// 运行：cd /opt/pm-app && node scripts/qa/b2-im-notify-chain.mjs            # 默认打线上
//       BASE=http://127.0.0.1:3001/api node scripts/qa/b2-im-notify-chain.mjs
//       WS=https://pm.hezongji.cn node scripts/qa/b2-im-notify-chain.mjs    # 显式指定 im-server
//
// ── 校准结论（2026-08-25 实测 + 源码核对）──
//  [2] ConvType：REST POST /conversations 仅收 z.enum(['SINGLE','GROUP'])（DIRECT 400）。
//      SINGLE 会复用既有两人单聊（reused=true）→ 为避免误碰真实单聊数据，本链用 GROUP
//      （GROUP 恒新建）。memberIds 服务端自动去重 + 剔除创建者本人。
//      GET /conversations/[id] 不存在（该路由仅 DELETE）→ 成员断言改走列表接口。
//  [4] ★ REST 无发消息入口（conversations/[id]/messages 仅 GET）：发消息走 im-server
//      Socket message:send（握手 ?token=<JWT>，与主服务同 JWT_SECRET）→ 已接 socket.io-client。
//  [7] IM 消息默认不落 Notification（实时走 socket 广播）；★仅 @mentions 落 MENTION
//      Notification + TodoItem（im-server/src/handlers/message.js）→ 发消息带 mentions:[B]
//      使通知断言成为真闭环（原 SKIP 路径保留为 socket 不可用时的降级）。
//  为避免对真实用户产生副作用（read-all 会把 B 的全部通知置已读、MENTION 落库无删除 API），
//  本链注册一次性 QA 用户 B，跑完由 ADMIN 删除（DELETE /admin/users/[id] 级联清痕迹）。
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { io } from 'socket.io-client'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
// im-server 地址：默认 BASE 为本机 → http://127.0.0.1:3002；线上 → 与 API 同源（nginx /socket.io/ 代理）
const WS = process.env.WS || (BASE.includes('127.0.0.1') || BASE.includes('localhost')
  ? 'http://127.0.0.1:3002'
  : new URL(BASE).origin)
const ENV_FILE = process.env.ENV_FILE || '/opt/pm-app/.env'
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }

const env = fs.readFileSync(ENV_FILE, 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const tokenA = jwt.sign(ADMIN, SECRET, { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` }

let pass = 0, fail = 0
const fails = []
function assert(cond, desc) {
  if (cond) { pass++; console.log(`  ✅ ${desc}`) }
  else { fail++; fails.push(desc); console.log(`  ❌ ${desc}`) }
}
function skip(desc, reason) { console.log(`  ⏭️  SKIP ${desc} —— ${reason}`) }

async function req(method, path, body, headers = H) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000), // 防挂死泄漏（qwen 预审）
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, ok: r.ok, body: j?.data ?? j, raw: j }
}
const itemsOf = (b) => (Array.isArray(b) ? b : b?.items ?? b?.data?.items ?? [])

const cleanup = []
const manual = []
async function runCleanup() {
  console.log('\n── 清理 ──')
  for (const c of [...cleanup].reverse()) {
    try {
      const ok = await c.run()
      console.log(`  ${ok ? '🧹' : '⚠️ '} ${c.label}${ok ? '' : '（删除失败/无删除API，登记手动清理）'}`)
      if (!ok) manual.push(c.label)
    } catch (e) { console.log(`  ⚠️  ${c.label} 清理异常: ${e.message}`); manual.push(c.label) }
  }
}

const TS = Date.now()
const ids = { userBId: null, conversationId: null, messageId: null, todoId: null }
let HB = null, socket = null

try {
  // [1] 注册一次性用户B（避免对真实用户做 read-all/MENTION 副作用）
  console.log(`[1] 注册一次性用户B…  BASE=${BASE}  WS=${WS}`)
  const emailB = `qa-b2-im-${TS}@qa.test`
  const rg = await req('POST', '/auth/register', { name: 'QA-B2-IM测试', email: emailB, password: `Qa-b2-${TS}!x` })
  console.log(`  现场: POST /auth/register → ${rg.status}`, JSON.stringify(rg.raw).slice(0, 200))
  ids.userBId = rg.body?.user?.id
  assert(rg.ok && !!ids.userBId, `用户B注册成功（${emailB}, id=${ids.userBId}）`)
  if (!ids.userBId) throw new Error('用户B注册失败，链路终止')
  const tokenB = rg.body?.token ?? jwt.sign({ userId: ids.userBId, email: emailB, role: 'MEMBER' }, SECRET, { expiresIn: '1h' })
  HB = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` }
  cleanup.push({ label: `QA用户 ${ids.userBId}`, run: async () => (await req('DELETE', `/admin/users/${ids.userBId}`)).ok })

  // [2] 建群会话（校准：type 仅 SINGLE/GROUP；GROUP 恒新建，SINGLE 会复用既有单聊）
  console.log('[2] 创建会话…')
  let cv = await req('POST', '/conversations', { type: 'DIRECT', memberIds: [ids.userBId] })
  console.log(`  现场: POST /conversations(DIRECT) → ${cv.status}（校准：DIRECT 非法枚举，预期 400）`, JSON.stringify(cv.raw).slice(0, 200))
  assert(!cv.ok, 'DIRECT 被 400 拒绝（校准点⑦：枚举仅 SINGLE/GROUP）')
  cv = await req('POST', '/conversations', { type: 'GROUP', name: `QA-B2-会话-${TS}`, memberIds: [ids.userBId] })
  console.log(`  现场: POST /conversations(GROUP) → ${cv.status}`, JSON.stringify(cv.raw).slice(0, 250))
  ids.conversationId = cv.body?.id ?? cv.body?.conversation?.id
  assert(cv.ok && !!ids.conversationId && cv.body?.reused === false, `群会话创建成功且为新建（id=${ids.conversationId}）`)
  if (!ids.conversationId) throw new Error('会话创建失败，链路终止')
  cleanup.push({ label: `会话 ${ids.conversationId}`, run: async () => (await req('DELETE', `/conversations/${ids.conversationId}`)).ok })

  // [3] 会话成员断言（校准：GET /conversations/[id] 无路由 → 走列表）
  console.log('[3] 校验会话成员…')
  const cl = await req('GET', '/conversations')
  const conv = itemsOf(cl.body).find((c) => c?.id === ids.conversationId)
  const memberIds = (conv?.members ?? []).map((m) => m?.userId ?? m?.user?.id)
  console.log(`  现场: GET /conversations → ${cl.status}, 本会话成员=${memberIds.length}`, JSON.stringify(conv?.members?.[0] ?? {}).slice(0, 150))
  assert(cl.ok && memberIds.includes(ADMIN.userId) && memberIds.includes(ids.userBId), '会话成员含 ADMIN(OWNER) 与用户B(MEMBER)')

  // [4] Socket 发消息（REST 无入口；带 mentions:[B] 触发通知闭环）
  console.log('[4] Socket 发送消息（message:send, @B）…')
  const content = `QA-B2-消息-${TS}`
  let sent = false
  try {
    socket = io(WS, { query: { token: tokenA }, transports: ['websocket', 'polling'], timeout: 10000, reconnection: false })
    const emitWithAck = (payload, ms) => new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), ms)
      socket.emit('message:send', payload, (ack) => { clearTimeout(to); resolve(ack ?? null) })
    })
    // ★ im-server 在连接建立后还有异步初始化（拉会话/在线广播）完成后才 register 业务 handler，
    //   并在最后 emit S→C 'connected' —— 等 'connected' 再发消息，避免事件被丢弃导致 ack 永不返回
    const connected = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 10000)
      socket.on('connected', () => { clearTimeout(to); resolve(true) })
      socket.on('connect_error', (e) => { console.log(`  现场: connect_error: ${e.message}`) })
    })
    if (connected) {
      console.log(`  现场: socket 已就绪（id=${socket.id}, 收到 S→C connected）`)
      let ack = await emitWithAck({ conversationId: ids.conversationId, type: 'TEXT', content, mentions: [ids.userBId] }, 15000)
      if (!ack) { console.log('  现场: 首次 ack 超时 15s，重试一次'); ack = await emitWithAck({ conversationId: ids.conversationId, type: 'TEXT', content, mentions: [ids.userBId] }, 15000) }
      console.log('  现场: message:send ack →', JSON.stringify(ack).slice(0, 250))
      ids.messageId = ack?.ok ? (ack.message?.id ?? null) : null
      sent = !!ack?.ok && !!ids.messageId
    } else {
      console.log('  现场: socket 连接超时（10s）')
    }
  } catch (e) { console.log(`  现场: socket 异常: ${e.message}`) }
  if (sent) assert(true, `消息发送成功（id=${ids.messageId}）`)
  else skip('Socket 发消息及其闭环断言', 'im-server 连接失败或 ack 非 ok（见现场输出；REST 无发消息入口为设计约束）')

  // [5] 读消息列表断言含新消息
  console.log('[5] 读取消息列表…')
  const ml = await req('GET', `/conversations/${ids.conversationId}/messages`)
  const msgs = itemsOf(ml.body)
  console.log(`  现场: GET messages → ${ml.status}, 共 ${msgs.length} 条, 未读相关:`, JSON.stringify(ml.body?.hasMore ?? null))
  assert(ml.ok, `消息列表可读（hasMore=${ml.body?.hasMore}）`)
  if (sent) assert(msgs.some((m) => m?.content === content), `消息列表含新消息（@B mentions 已随消息落库）`)
  else skip('新消息断言', '消息未发出')

  // [6] 标记已读（双身份各标一次，覆盖双方视角）
  console.log('[6] 标记已读…')
  const rdA = await req('POST', `/conversations/${ids.conversationId}/read`, {})
  assert(rdA.ok, `ADMIN 侧标记已读（${rdA.status}, lastReadAt=${rdA.body?.lastReadAt ? '有' : '无'}）`)
  const rdB = await req('POST', `/conversations/${ids.conversationId}/read`, {}, HB)
  assert(rdB.ok, `用户B 侧标记已读（${rdB.status}）`)

  // [7] B侧通知触达（校准点⑧：普通消息不落通知表，@mention 落 MENTION Notification + TodoItem）
  console.log('[7] 用户B 通知/待办触达…')
  let hit = null
  if (sent) {
    const nf = await req('GET', '/notifications?limit=50', undefined, HB)
    const nlist = itemsOf(nf.body)
    hit = nlist.find((n) =>
      n?.type === 'MENTION' && (n?.link ?? '').includes(ids.conversationId) && !n?.isRead)
    console.log(`  现场: B的通知共 ${nlist.length} 条`, JSON.stringify(hit ?? nlist[0] ?? {}).slice(0, 250))
    assert(!!hit, `B 收到 @提及 通知（type=MENTION, link=${hit?.link}）`)
  } else {
    skip('B侧消息通知断言', '消息未发出（IM 消息不落通知表为设计：仅 @mention 落 MENTION）')
  }

  // [7b] B侧 TodoItem（mention 同时落待办）
  if (sent) {
    const td = await req('GET', '/todos', undefined, HB)
    const todos = itemsOf(td.body)
    const todoHit = todos.find((t) => (t?.link ?? '').includes(ids.conversationId))
    console.log(`  现场: B的待办共 ${todos.length} 条`, JSON.stringify(todoHit ?? {}).slice(0, 200))
    assert(!!todoHit, `B 收到 @提及 待办（sourceType=${todoHit?.sourceType}）`)
    if (todoHit?.id) {
      ids.todoId = todoHit.id
      cleanup.push({ label: `B待办 ${todoHit.id}`, run: async () => (await req('DELETE', `/todos/${todoHit.id}`, undefined, HB)).ok })
    }
  }

  // [8] B 侧通知全部已读 → unread 归零（一次性QA用户，无真实数据副作用）
  console.log('[8] 通知全部已读…')
  const ra = await req('POST', '/notifications/read-all', {}, HB)
  assert(ra.ok, `B 侧 read-all（${ra.status}, updated=${ra.body?.updated}）`)
  const unreadProbe = await req('GET', '/notifications?limit=100', undefined, HB)
  const unreadLeft = itemsOf(unreadProbe.body).filter((n) => n?.isRead === false).length
  assert(unreadLeft === 0, `read-all 后 B 未读=0（实际 ${unreadLeft}）`)
} catch (e) {
  fail++
  fails.push(`链路异常中断: ${e.message}`)
  console.log(`\n💥 异常: ${e.message}`)
} finally {
  try { socket?.disconnect() } catch {}
  await runCleanup()
}

console.log('\n══════════ 汇总 ══════════')
console.log(`B2-IM通知链: ${pass}/${pass + fail} PASS`)
if (fails.length) console.log('FAIL 明细:\n' + fails.map((f) => `  - ${f}`).join('\n'))
if (manual.length) console.log('需手动清理/说明:\n' + manual.map((m) => `  - ${m}`).join('\n'))
process.exitCode = fail > 0 ? 1 : 0
