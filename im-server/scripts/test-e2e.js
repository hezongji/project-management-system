'use strict';

/**
 * 端到端联调脚本（socket.io-client）。
 * 默认自拉起一个 memory 模式的 im-server（:3102），跑完自动关闭，自包含可复现。
 * 覆盖验收项：
 *   1. 两个测试 token 连接成功
 *   2. A 发消息 → B 收到（message:new）
 *   3. typing / presence:sync 事件
 *   4. 断线重连后恢复订阅（B 重连后仍能收到 A 的消息）
 *   5. 未授权 token 被拒绝
 *
 * 用法：
 *   node scripts/test-e2e.js                       # 自拉起 memory 服务并测试
 *   IM_E2E_TARGET=http://localhost:3002 node scripts/test-e2e.js   # 连已启动的服务
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const config = require('../src/config');

const TEST_PORT = Number(process.env.IM_TEST_PORT || 3102);
const TARGET = process.env.IM_E2E_TARGET || `http://localhost:${TEST_PORT}`;
const CONV = process.env.TEST_CONV || 'conv-demo';
const CONFIG_SECRET = config.JWT_SECRET;

const sign = (userId, email, role, name) =>
  jwt.sign({ userId, email, role, name }, CONFIG_SECRET, { expiresIn: '30d' });

const TOKEN_A = process.env.TOKEN_A || sign('test-user-a', 'a@test.dev', 'USER', '用户A');
const TOKEN_B = process.env.TOKEN_B || sign('test-user-b', 'b@test.dev', 'USER', '用户B');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✘ ${name}`);
  }
}

/* ---------- 自拉起 memory 模式服务 ---------- */
function startServer() {
  if (process.env.IM_E2E_TARGET) return null; // 连外部服务，不拉起
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      IM_STORE: 'memory',
      IM_PORT: String(TEST_PORT),
      IM_SEED_DEMO: 'true',
      IM_NOTIFY_CHANNEL: 'im_events',
      DATABASE_URL: '', // 强制 memory 路径
      IM_DATABASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.stderr.on('data', (d) => { buf += d.toString(); });
  return { child, getLog: () => buf };
}

function waitHealthy(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const req = http.get(url + '/health', (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); retry(); });
      function retry() {
        if (Date.now() - start > timeoutMs) reject(new Error('服务健康检查超时'));
        else setTimeout(poll, 300);
      }
    };
    poll();
  });
}

function connect(token, label) {
  return new Promise((resolve, reject) => {
    const s = ioClient(TARGET, {
      auth: { token },
      query: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${label} 连接失败: ${e.message}`)));
    setTimeout(() => reject(new Error(`${label} 连接超时`)), 8000);
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = startServer();
  if (server) {
    process.stdout.write('自拉起 memory 服务…');
    await waitHealthy(TARGET);
    console.log(' 就绪 ✔');
  }
  console.log(`联调目标: ${TARGET}  会话: ${CONV}\n`);

  // ── 1. 双 token 连接 ──
  console.log('[1] 双 token 连接');
  let a, b;
  try { a = await connect(TOKEN_A, 'A'); console.log('  ✔ A 已连接'); passed += 1; }
  catch (e) { console.log(`  ✘ ${e.message}`); failed += 1; }
  try { b = await connect(TOKEN_B, 'B'); console.log('  ✔ B 已连接'); passed += 1; }
  catch (e) { console.log(`  ✘ ${e.message}`); failed += 1; }

  if (!a || !b) {
    console.error('\n基础连接失败，终止。');
    if (server) server.child.kill();
    process.exit(1);
  }

  await sleep(500);

  // ── 2. A 发消息 → B 收到 ──
  console.log('\n[2] A 发消息 → B 收到');
  const msgContent = `hello-from-A-${Date.now()}`;
  const gotB = once(b, 'message:new');
  a.emit('message:send', { conversationId: CONV, type: 'TEXT', content: msgContent });
  try {
    const data = await gotB;
    check('B 收到 message:new', !!data && data.message);
    check('消息内容一致', data.message.content === msgContent);
    check('消息带 conversationId', data.conversationId === CONV);
  } catch (e) {
    check(`B 收到消息（${e.message}）`, false);
  }

  // ── 3. typing 转发 ──
  console.log('\n[3] typing 转发');
  const gotTyping = once(b, 'typing');
  a.emit('typing', { conversationId: CONV });
  try {
    const t = await gotTyping;
    check('B 收到 typing', t && t.userId === 'test-user-a');
  } catch (e) {
    check(`B 收到 typing（${e.message}）`, false);
  }

  // ── 4. presence:sync（通过 A 断线/重连触发在线变化）──
  console.log('\n[4] presence:sync');
  try {
    const pListen1 = once(b, 'presence:sync');
    a.disconnect();
    const p1 = await pListen1;
    check('A 离线时 B 收到 presence:sync', true);
    check('A 已从在线列表移除', !(p1.onlineUserIds || []).includes('test-user-a'));

    const pListen2 = once(b, 'presence:sync');
    a = await connect(TOKEN_A, 'A(重连)');
    const p2 = await pListen2;
    check('A 上线时 B 收到 presence:sync', true);
    check('在线列表含 A', (p2.onlineUserIds || []).includes('test-user-a'));
  } catch (e) {
    check(`presence:sync 流程（${e.message}）`, false);
  }

  // ── 5. 断线重连恢复订阅 ──
  console.log('\n[5] 断线重连恢复订阅');
  b.disconnect();
  await sleep(300);
  let b2;
  try {
    b2 = await connect(TOKEN_B, 'B(重连)');
    console.log('  ✔ B 已重连');
    passed += 1;
  } catch (e) {
    console.log(`  ✘ B 重连失败: ${e.message}`);
    failed += 1;
  }
  if (b2) {
    await sleep(500);
    const msg2 = `after-reconnect-${Date.now()}`;
    const gotB2 = once(b2, 'message:new');
    a.emit('message:send', { conversationId: CONV, type: 'TEXT', content: msg2 });
    try {
      const d2 = await gotB2;
      check('重连后 B 仍收到消息（订阅恢复）', d2.message.content === msg2);
    } catch (e) {
      check(`重连后 B 收到消息（${e.message}）`, false);
    }
  }

  // ── 6. 未授权 token 应被拒 ──
  console.log('\n[6] 未授权 token 拒绝');
  try {
    await connect('invalid-token-xyz', 'C');
    check('非法 token 被拒绝', false);
  } catch (e) {
    check('非法 token 被拒绝（unauthorized）', /unauthorized|连接失败/i.test(e.message));
  }

  if (a && a.connected) a.disconnect();
  if (b2) b2.disconnect();
  else if (b && b.connected) b.disconnect();

  if (server) server.child.kill();

  console.log(`\n========== 结果: ${passed} 通过 / ${failed} 失败 ==========`);
  if (failed > 0) {
    console.log('失败项:', failures.join(' | '));
    process.exit(1);
  } else {
    console.log('全部验收通过 ✔');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
