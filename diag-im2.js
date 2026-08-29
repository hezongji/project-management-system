// 白盒隔离: store 层对 陈牧之 vs 张恒宇 的行为差异
const { PrismaStore } = require('/opt/pm-app/im-server/src/store/prisma.js');
const { PrismaClient } = require("/opt/pm-app/node_modules/@prisma/client");
const store = new PrismaStore(new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }));
const CID = 'cmt8s30wj002tv5w986b4uy78';
const CMZ = 'cmt7cdbzv001ov55otclrv94t';  // 陈牧之
const ZHY = 'cmt7cdbzl001kv55ovrcrz6mc';  // 张恒宇
(async () => {
  for (const [name, uid] of [['陈牧之', CMZ], ['张恒宇', ZHY]]) {
    const t0 = Date.now();
    const m = await store.isMember(CID, uid);
    console.log(`isMember ${name}: ${m} (${Date.now() - t0}ms)`);
  }
  // 陈牧之 createMessage 隔离测试(带测试标记,随后删除)
  const t0 = Date.now();
  try {
    const msg = await store.createMessage({ conversationId: CID, senderId: CMZ, senderName: '陈牧之(白盒)', type: 'TEXT', content: 'WHITEBOX-TEST-将删除-' + Date.now() });
    console.log(`createMessage 陈牧之: OK id=${msg.id.slice(0, 12)} (${Date.now() - t0}ms)`);
    await store.touchConversation(CID);
    console.log('touchConversation: OK');
    // 清理
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    await p.message.deleteMany({ where: { content: { startsWith: 'WHITEBOX-TEST-' } } });
    console.log('白盒测试消息已清理');
    await p.$disconnect();
  } catch (e) {
    console.log(`createMessage 陈牧之: ❌ ${e.message} (${Date.now() - t0}ms)`);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
