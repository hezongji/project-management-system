'use strict';

/**
 * P4「事件全表补全 + @提及待办落库」单元验证（不依赖 PG，用 MemoryStore + 假 socket）。
 * 覆盖：
 *   ① revoke 2 分钟时限（超时拒 / 窗口内放行）
 *   ② revoke 仅发送者本人（他人拒）
 *   ③ @提及 → Notification + TodoItem 落库 + notify:push + todo:push
 */

const MemoryStore = require('../src/store/memory');
const { registerMessageHandlers } = require('../src/handlers/message');
const { CLIENT, SERVER } = require('../src/events');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; console.log(`  ✘ ${name}`, extra === undefined ? '' : JSON.stringify(extra)); }
}

function makeContext(store, user) {
  const emits = [];
  const io = {
    to: (room) => ({
      emit: (evt, data) => { emits.push({ room, evt, data }); },
    }),
  };
  const config = { ROOM_CONV: (id) => `conv:${id}`, ROOM_USER: (id) => `user:${id}` };
  const handlers = {};
  const socket = {
    data: { user },
    on: (evt, fn) => { handlers[evt] = fn; },
  };
  const ctx = { io, store, config, log: { error: () => {}, info: () => {} } };
  registerMessageHandlers(ctx, socket);
  return { handlers, emits, store };
}

async function main() {
  const store = new MemoryStore();
  await store.createConversation({ id: 'c1', createdBy: 'u1', memberIds: ['u1', 'u2'] });
  const u1 = { userId: 'u1', name: '用户A', email: 'a@x', role: 'USER' };
  const u2 = { userId: 'u2', name: '用户B', email: 'b@x', role: 'USER' };

  // ── ① revoke：本人、窗口内 → 放行 ──
  console.log('[1] revoke 本人窗口内放行');
  {
    const fresh = await store.createMessage({ conversationId: 'c1', senderId: 'u1', type: 'TEXT', content: 'hi' });
    const { handlers, emits } = makeContext(store, u1);
    let ack;
    await handlers[CLIENT.MESSAGE_REVOKE]({ messageId: fresh.id }, (r) => { ack = r; });
    check('ack ok=true', ack && ack.ok === true, ack);
    check('消息 revoked=true', ack && ack.message && ack.message.revoked === true, ack);
    check('广播 message:new(revoked:true)', emits.some((e) => e.evt === SERVER.MESSAGE_NEW && e.data.revoked === true), emits);
  }

  // ── ① revoke：超 2 分钟 → 拒 ──
  console.log('[2] revoke 超 2 分钟被拒');
  {
    const old = await store.createMessage({ conversationId: 'c1', senderId: 'u1', type: 'TEXT', content: 'old' });
    store.messages.get('c1').find((m) => m.id === old.id).createdAt = new Date(Date.now() - 3 * 60 * 1000);
    const { handlers } = makeContext(store, u1);
    let ack;
    await handlers[CLIENT.MESSAGE_REVOKE]({ messageId: old.id }, (r) => { ack = r; });
    check('ack ok=false', ack && ack.ok === false, ack);
    check('error = exceed 2 minutes revoke window', ack && ack.error === 'exceed 2 minutes revoke window', ack);
  }

  // ── ② revoke：非发送者 → 拒 ──
  console.log('[3] revoke 非本人被拒');
  {
    const mine = await store.createMessage({ conversationId: 'c1', senderId: 'u1', type: 'TEXT', content: 'u1 says' });
    const { handlers } = makeContext(store, u2);
    let ack;
    await handlers[CLIENT.MESSAGE_REVOKE]({ messageId: mine.id }, (r) => { ack = r; });
    check('ack ok=false', ack && ack.ok === false, ack);
    check('error = forbidden: not the sender', ack && ack.error === 'forbidden: not the sender', ack);
  }

  // ── ③ @提及落库 + 推送 ──
  console.log('[4] @提及落库 Notification + TodoItem + 推送');
  {
    const { handlers, emits } = makeContext(store, u1);
    let ack;
    await handlers[CLIENT.MESSAGE_SEND]({
      conversationId: 'c1', type: 'TEXT', content: 'hello @用户B', mentions: ['u2'],
    }, (r) => { ack = r; });
    check('message:send ack ok=true', ack && ack.ok === true, ack);
    const notif = store.notifications.find((n) => n.userId === 'u2' && n.type === 'MENTION');
    check('Notification 已落库(userId=u2, type=MENTION)', !!notif, store.notifications);
    check('Notification.link 指向会话', notif && notif.link === '/messages?conversation=c1', notif);
    const todo = store.todos.find((t) => t.userId === 'u2' && t.sourceType === 'MESSAGE');
    check('TodoItem 已落库(sourceType=MESSAGE)', !!todo, store.todos);
    check('TodoItem.sourceId = message.id', todo && todo.sourceId === ack.message.id, todo);
    check('TodoItem.priority = MEDIUM', todo && todo.priority === 'MEDIUM', todo);
    const np = emits.find((e) => e.evt === SERVER.NOTIFY_PUSH && e.room === 'user:u2');
    check('notify:push 发往 user:u2', !!np, emits);
    const tp = emits.find((e) => e.evt === SERVER.TODO_PUSH && e.room === 'user:u2');
    check('todo:push 发往 user:u2', !!tp, emits);
    check('todo:push 携带 todoItem', tp && tp.data && tp.data.todoItem && tp.data.todoItem.id === todo.id, tp);
  }

  console.log(`\n========== 结果: ${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
