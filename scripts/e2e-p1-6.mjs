/**
 * P1-6 e2e 验证链路：建项 → 建群 → 拉人 → 欢迎消息实时推送 → unread/标读
 *
 * 依据《开发文档-项目管理系统重构》§7.4（POST /projects）/ §7.8（IM REST）/
 * §9.2（事件表）/ §9.4（主服务↔IM 联动）。
 *
 * 验证链路：
 *   1. 双账号（chenmuzhi ADMIN / sunruoqing MEMBER）Socket 连接 im-server(:3002)
 *   2. chenmuzhi POST /api/projects 建项目（members 含 sunruoqing）
 *      → phase-engine 事务内：建 PROJECT_GROUP 会话 + 拉全部成员 + SYSTEM 欢迎消息
 *        + PG NOTIFY im_events（conv:created + message:new）
 *   3. 断言双 Socket 均收到 message:new（PROJECT_GROUP 欢迎消息，type=SYSTEM）
 *   4. GET /api/conversations 断言新建会话 unread=1（欢迎消息未读）
 *   5. sunruoqing POST /api/conversations/:id/read 标读 → unread 清零（再 GET 复核）
 *   6. 清理测试数据（conversation → project 级联）
 *
 * 前置：主服务(:3000) + im-server(:3002) + PG(pm_dev) 均已运行。
 *   node scripts/e2e-p1-6.mjs
 *   E2E_BASE=... IM_E2E_TARGET=... node scripts/e2e-p1-6.mjs
 */

import { PrismaClient } from '@prisma/client'
import { io as ioClient } from 'socket.io-client'

const BASE = process.env.E2E_BASE || 'http://localhost:3000'
const IM_TARGET = process.env.IM_E2E_TARGET || 'http://localhost:3002'
const prisma = new PrismaClient()

const log = (...args) => console.log(...args)
let step = 0
const header = (name) => log(`\n━━━ [${++step}] ${name} ━━━`)

let passed = 0
let failed = 0
function assert(cond, msg, extra) {
  if (cond) {
    passed += 1
    log(`  ✓ ${msg}`)
  } else {
    failed += 1
    log(`  ✗ ${msg}`, extra ?? '')
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const s = ioClient(IM_TARGET, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    })
    s.on('connect', () => resolve(s))
    s.on('connect_error', (e) => reject(new Error(`${label} 连接失败: ${e.message}`)))
    setTimeout(() => reject(new Error(`${label} 连接超时`)), 8000)
  })
}

function onceEvent(socket, event, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeoutMs)
    socket.once(event, (data) => {
      clearTimeout(t)
      resolve(data)
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // [1] 登录双账号
  header('登录双账号（chenmuzhi ADMIN / sunruoqing MEMBER）')
  const loginA = await api('POST', '/auth/login', {
    body: { email: 'chenmuzhi@example.com', password: 'demo123456' },
  })
  assert(loginA.status === 200 && loginA.body?.success, 'chenmuzhi 登录成功')
  const tokenA = loginA.body.data.token
  const userA = loginA.body.data.user

  const loginB = await api('POST', '/auth/login', {
    body: { email: 'sunruoqing@example.com', password: 'demo123456' },
  })
  assert(loginB.status === 200 && loginB.body?.success, 'sunruoqing 登录成功')
  const tokenB = loginB.body.data.token
  const userB = loginB.body.data.user
  log(`  A=${userA.email}(${userA.id.slice(0, 8)}…)  B=${userB.email}(${userB.id.slice(0, 8)}…)`)

  // [2] 双 Socket 连接 im-server（建项前在线，conv:created 才能补入房）
  header('双 Socket 连接 im-server')
  let sa, sb
  try {
    sa = await connectSocket(tokenA, 'A')
    log('  ✓ A 已连接 im-server')
    passed += 1
  } catch (e) {
    log(`  ✗ ${e.message}`)
    failed += 1
  }
  try {
    sb = await connectSocket(tokenB, 'B')
    log('  ✓ B 已连接 im-server')
    passed += 1
  } catch (e) {
    log(`  ✗ ${e.message}`)
    failed += 1
  }
  if (!sa || !sb) {
    log('\n基础连接失败，终止。')
    process.exit(1)
  }
  await sleep(500)

  // [3] 建项（POST /api/projects，members 含 sunruoqing）
  const projectName = `P1-6 e2e 验证项目 ${Date.now()}`
  header(`建项：POST /api/projects（members 含 sunruoqing）`)
  const gotA = onceEvent(sa, 'message:new')
  const gotB = onceEvent(sb, 'message:new')

  const created = await api('POST', '/projects', {
    token: tokenA,
    body: {
      name: projectName,
      description: 'P1-6 IM 链路 e2e 验证',
      priority: 'MEDIUM',
      members: [{ userId: userB.id, role: 'MEMBER' }],
    },
  })
  assert(created.status === 201 && created.body?.success, `建项成功（201）：${created.body?.message ?? ''}`)
  const conversationId = created.body.data?.conversationId
  const projectId = created.body.data?.project?.id
  assert(!!conversationId, '返回 conversationId（PROJECT_GROUP 会话已建）')
  assert(!!projectId, '返回 project.id')
  log(`  projectId=${projectId}  conversationId=${conversationId}`)

  // [4] 双 Socket 收到欢迎消息
  header('双 Socket 收到 PROJECT_GROUP 欢迎消息')
  const [msgA, msgB] = await Promise.all([gotA, gotB]).catch((e) => {
    assert(false, `双 Socket 收到欢迎消息（${e.message}）`)
    return [null, null]
  })
  if (msgA && msgB) {
    assert(msgA.conversationId === conversationId, 'A 收到欢迎消息（conversationId 一致）')
    assert(msgA.message?.type === 'SYSTEM', 'A 消息 type=SYSTEM')
    assert(msgB.conversationId === conversationId, 'B 收到欢迎消息（conversationId 一致）')
    assert(msgB.message?.type === 'SYSTEM', 'B 消息 type=SYSTEM')
    assert(
      msgA.message?.content?.includes(projectName.split(' ')[0]) ||
        /项目/.test(msgA.message?.content ?? ''),
      '欢迎消息内容含项目信息',
    )
  }

  // [5] 会话列表 unread 校验
  header('GET /api/conversations 校验 unread')
  const convsA = await api('GET', '/conversations', { token: tokenA })
  const convsB = await api('GET', '/conversations', { token: tokenB })
  assert(convsA.status === 200 && Array.isArray(convsA.body?.data), 'A 会话列表返回')
  assert(convsB.status === 200 && Array.isArray(convsB.body?.data), 'B 会话列表返回')

  const itemA = convsA.body.data.find((c) => c.id === conversationId)
  const itemB = convsB.body.data.find((c) => c.id === conversationId)
  assert(!!itemA, 'A 会话列表含新会话')
  assert(!!itemB, 'B 会话列表含新会话')
  assert(itemA?.type === 'PROJECT_GROUP', '会话 type=PROJECT_GROUP')
  assert(itemA?.unread >= 1, `A unread ≥ 1（欢迎消息未读，实测 ${itemA?.unread}）`)
  assert(itemB?.unread >= 1, `B unread ≥ 1（欢迎消息未读，实测 ${itemB?.unread}）`)
  assert(!!itemA?.lastMessage, 'A lastMessage 摘要返回')
  assert(Array.isArray(itemA?.members) && itemA.members.length >= 2, 'A 成员摘要含 ≥2 人')
  log(`  A unread=${itemA?.unread}  B unread=${itemB?.unread}  成员数=${itemA?.members?.length}`)

  // [6] 标读 → unread 清零
  header('POST /api/conversations/:id/read 标读 → unread 清零')
  const readB = await api('POST', `/conversations/${conversationId}/read`, { token: tokenB })
  assert(readB.status === 200 && readB.body?.success, 'B 标读成功（200）')
  assert(readB.body?.data?.lastReadAt, '返回 lastReadAt')

  const convsB2 = await api('GET', '/conversations', { token: tokenB })
  const itemB2 = convsB2.body.data.find((c) => c.id === conversationId)
  assert(itemB2?.unread === 0, `B 标读后 unread=0（实测 ${itemB2?.unread}）`)

  const convsA2 = await api('GET', '/conversations', { token: tokenA })
  const itemA2 = convsA2.body.data.find((c) => c.id === conversationId)
  assert(itemA2?.unread >= 1, `A 未标读，unread 仍 ≥1（实测 ${itemA2?.unread}）`)

  // [7] 历史消息分页
  header('GET /api/conversations/:id/messages 历史消息（游标倒序）')
  const msgs = await api('GET', `/conversations/${conversationId}/messages?limit=50`, {
    token: tokenB,
  })
  assert(msgs.status === 200 && msgs.body?.success, '消息列表返回')
  assert(Array.isArray(msgs.body?.data?.items) && msgs.body.data.items.length >= 1, '含欢迎消息')
  assert(msgs.body.data.items[0].type === 'SYSTEM', '倒序首条=最新（欢迎消息）')
  assert(typeof msgs.body.data.hasMore === 'boolean', '返回 hasMore')
  log(`  消息数=${msgs.body.data.items.length}  hasMore=${msgs.body.data.hasMore}`)

  // [8] 非成员越权读消息 → 403
  header('权限抽检：非成员读消息 → 403')
  const outsider = await prisma.user.findFirst({
    where: {
      role: 'MEMBER',
      isActive: true,
      AND: [{ id: { not: userA.id } }, { id: { not: userB.id } }],
      conversations: { none: { conversationId } },
    },
    select: { email: true },
  })
  if (outsider) {
    const loginOut = await api('POST', '/auth/login', {
      body: { email: outsider.email, password: 'demo123456' },
    })
    if (loginOut.status === 200) {
      const forbidden = await api('GET', `/conversations/${conversationId}/messages`, {
        token: loginOut.body.data.token,
      })
      assert(forbidden.status === 403, `非成员读消息 → 403（实测 ${forbidden.status}）`)
    } else {
      log(`  ⚠ ${outsider.email} 登录失败，跳过 403 抽检`)
    }
  }
  const noAuth = await api('GET', `/conversations/${conversationId}/messages`)
  assert(noAuth.status === 401, '未认证读消息 → 401')

  // ── 清理 ──
  header('清理测试数据')
  try {
    await prisma.conversation.deleteMany({ where: { projectId } })
    await prisma.project.delete({ where: { id: projectId } })
    log(`  已删除 conversation + project ${projectId}（级联 phase/catalog/requirement/member/message）`)
    passed += 1
  } catch (e) {
    log(`  ✗ 清理失败：${e.message}`)
    failed += 1
  }

  if (sa?.connected) sa.disconnect()
  if (sb?.connected) sb.disconnect()

  log(`\n========== 结果: ${passed} 通过 / ${failed} 失败 ==========`)
  if (failed > 0) process.exitCode = 1
  else log('全部验收通过 ✔')
}

main()
  .catch((e) => {
    console.error('\n✗ e2e 失败：', e.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
