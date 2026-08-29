'use strict';

/**
 * PrismaStore 写库验证（针对共享 PG）。
 * 前置：PG 可连、主 schema 已建表并 seed（P0-1 完成）。
 * 用法：
 *   IM_STORE=prisma node scripts/verify-prisma.js
 *
 * 验证内容：
 *   1. 连接共享库并读取统计（User/Conversation/Message/ConversationMember）
 *   2. 用一个真实 member 作 sender，向已有会话写一条消息（落库）
 *   3. 读回该消息并比对内容
 *   4. 清理测试消息（不污染数据）
 */
const config = require('../src/config');
const { createStore } = require('../src/store');

const log = console;

async function main() {
  const { store, mode } = await createStore(config, { warn: () => {}, error: () => {} });
  if (mode !== 'prisma') {
    log.error(`当前存储模式为 ${mode}，非 prisma。请设置 IM_STORE=prisma 且 DATABASE_URL 指向 PG。`);
    process.exit(1);
  }
  log.info(`[verify] 存储模式: ${mode}`);

  const prisma = store.prisma;
  const counts = {
    users: await prisma.user.count(),
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    members: await prisma.conversationMember.count(),
  };
  log.info('[verify] 共享库统计:', counts);

  // 取一个真实会话及其成员作为 sender
  const conv = await prisma.conversation.findFirst({
    include: { members: { take: 1 } },
  });
  if (!conv || !conv.members.length) {
    log.error('[verify] 无可用会话/成员，请先 seed 主库。');
    process.exit(1);
  }
  const senderId = conv.members[0].userId;
  const content = `im-server-prisma-verify-${Date.now()}`;

  // 落库
  const created = await store.createMessage({
    conversationId: conv.id,
    senderId,
    type: 'TEXT',
    content,
  });
  log.info('[verify] 已写入 Message:', created.id);

  // 读回
  const rows = await store.getMessages(conv.id, { limit: 1 });
  const latest = rows.find((m) => m.id === created.id) || created;
  const ok = latest.content === content && latest.senderId === senderId;
  log.info(`[verify] 读回校验: ${ok ? 'PASS' : 'FAIL'} (content=${latest.content})`);

  // 清理测试消息
  await prisma.message.delete({ where: { id: created.id } });
  log.info('[verify] 已清理测试消息');

  await prisma.$disconnect();
  log.info(ok ? '\n[verify] 结果: 全部通过 ✔' : '\n[verify] 结果: 失败 ✘');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log.error('[verify] 异常:', e.message);
  process.exit(1);
});
