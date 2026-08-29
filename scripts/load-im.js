'use strict';
/**
 * P6 压测脚本（IM 部分）—— 50 并发 Socket.IO 连接 + 各发 1 条消息。
 * 用法: node scripts/load-im.js
 * 输出: 控制台 + scripts/p6-load-im-results.json
 */
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const SECRET = require('../im-server/src/config').JWT_SECRET;

const IM_URL = process.env.IM_URL || 'http://localhost:3002';
const CONNECTIONS = Number(process.env.CONNECTIONS || 50);
const CONV_ID = process.env.CONV_ID || 'cmszmbz5l00agu75c9zho4co8'; // DEMO25021 项目群

// 会话真实成员（轮询复用，保证 isMember 通过）
const MEMBERS = [
  'cmszmbyyu001iu75croddyo1f',
  'cmszmbyyt001hu75cs2ut3g71',
  'cmszmbyyw001ku75cfq5gxvhz',
  'cmszmbyyx001lu75cbkysav45',
  'cmszmbyyz001nu75cuthq3vjc',
  'cmszmbyz1001pu75c0hvtp718',
  'cmszmbyyy001mu75ceao8tmzd',
];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(i, sorted.length - 1))];
}

function makeToken(userId) {
  return jwt.sign({ userId, email: userId + '@load.dev', role: 'MEMBER', name: '压测-' + userId.slice(-4) }, SECRET, { expiresIn: '1d' });
}

const connectLat = [];      // io() 创建 → connected 事件
const ackLat = [];          // send → ack 回包
const bcastLat = [];        // send → 自己消息的 message:new 广播
let connectOk = 0, connectErr = 0, ackOk = 0, ackFail = 0, bcastOk = 0, bcastMiss = 0;
const errors = [];

function oneClient(idx) {
  return new Promise((resolve) => {
    const userId = MEMBERS[idx % MEMBERS.length];
    const token = makeToken(userId);
    const tCreate = Date.now();
    const s = io(IM_URL, { query: { token }, transports: ['websocket'], timeout: 8000, reconnection: false });

    const received = new Map(); // messageId -> { ts }
    let myMsgId = null;
    let sendTime = null;
    let settled = false;

    const finish = () => { if (!settled) { settled = true; s.close(); resolve(); } };
    const timeout = setTimeout(() => {
      if (!settled) { errors.push(`[${idx}] timeout (ackOk=${ackOk})`); finish(); }
    }, 10000);

    s.on('connect_error', (e) => {
      connectErr++;
      errors.push(`[${idx}] connect_error: ${e.message}`);
      clearTimeout(timeout);
      finish();
    });

    s.on('connected', () => {
      connectOk++;
      connectLat.push(Date.now() - tCreate);
      // 开始发消息
      s.on('message:new', (m) => {
        if (m && m.message && m.message.id) received.set(m.message.id, { ts: Date.now() });
      });

      sendTime = Date.now();
      s.emit('message:send', { conversationId: CONV_ID, type: 'TEXT', content: 'P6压测消息#' + idx + '-' + Date.now() }, (ack) => {
        const tAck = Date.now();
        if (ack && ack.ok) {
          ackOk++;
          ackLat.push(tAck - sendTime);
          myMsgId = ack.message && ack.message.id;
          // 广播一般先于 ack，可能已收到
          if (myMsgId && received.has(myMsgId)) {
            bcastOk++;
            bcastLat.push(received.get(myMsgId).ts - sendTime);
            finish();
          } else if (myMsgId) {
            // 等广播（最多 3s）
            const waitStart = Date.now();
            const poll = setInterval(() => {
              if (received.has(myMsgId)) {
                bcastOk++;
                bcastLat.push(received.get(myMsgId).ts - sendTime);
                clearInterval(poll);
                finish();
              } else if (Date.now() - waitStart > 3000) {
                bcastMiss++;
                clearInterval(poll);
                finish();
              }
            }, 10);
          } else {
            bcastMiss++;
            finish();
          }
        } else {
          ackFail++;
          errors.push(`[${idx}] ack fail: ${ack && ack.error}`);
          finish();
        }
      });
    });
  });
}

(async () => {
  const t0 = Date.now();
  console.log(`IM 压测: ${CONNECTIONS} 并发连接 → ${IM_URL} 会话=${CONV_ID}`);
  await Promise.all(Array.from({ length: CONNECTIONS }, (_, i) => oneClient(i)));
  const wallMs = Date.now() - t0;

  const sort = (a) => a.slice().sort((x, y) => x - y);
  const cl = sort(connectLat), al = sort(ackLat), bl = sort(bcastLat);

  const stat = {
    imUrl: IM_URL,
    conversationId: CONV_ID,
    connections: CONNECTIONS,
    connectOk, connectErr,
    connectP50: pct(cl, 50), connectP95: pct(cl, 95), connectMax: cl.length ? cl[cl.length - 1] : 0,
    ackOk, ackFail,
    ackP50: pct(al, 50), ackP95: pct(al, 95), ackP99: pct(al, 99), ackMax: al.length ? al[al.length - 1] : 0,
    bcastOk, bcastMiss,
    bcastP50: pct(bl, 50), bcastP95: pct(bl, 95), bcastP99: pct(bl, 99), bcastMax: bl.length ? bl[bl.length - 1] : 0,
    wallMs,
    errors: errors.slice(0, 20),
  };
  console.log(`连接成功=${connectOk}/${CONNECTIONS}  连接耗时 P50=${stat.connectP50}ms P95=${stat.connectP95}ms`);
  console.log(`消息 ack 成功=${ackOk} 失败=${ackFail}  P50=${stat.ackP50}ms P95=${stat.ackP95}ms P99=${stat.ackP99}ms`);
  console.log(`广播回包成功=${bcastOk} 缺失=${bcastMiss}  P50=${stat.bcastP50}ms P95=${stat.bcastP95}ms P99=${stat.bcastP99}ms`);
  console.log(`总耗时 ${wallMs}ms`);
  if (errors.length) console.log('错误样例:', errors.slice(0, 5));

  require('fs').writeFileSync(__dirname + '/p6-load-im-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), ...stat }, null, 2));
  console.log('结果已写入 scripts/p6-load-im-results.json');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
