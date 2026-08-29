'use strict';

const http = require('http');
const config = require('./config');
const { createStore } = require('./store');
const { createIo } = require('./server');
const { startListener } = require('./listener');

const log = {
  info: (...a) => console.log(new Date().toISOString(), '[INFO ]', ...a),
  warn: (...a) => console.log(new Date().toISOString(), '[WARN ]', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[ERROR]', ...a),
  debug: (...a) => process.env.DEBUG && console.log(new Date().toISOString(), '[DEBUG]', ...a),
};

async function seedDemoConversation(store, config) {
  if (!config.SEED_DEMO) return;
  // 演示群：test-user-a / test-user-b / test-user-c（联调脚本依赖）
  if (!(await store.getConversation('conv-demo'))) {
    await store.createConversation({
      id: 'conv-demo',
      type: 'GROUP',
      name: '联调演示群',
      createdBy: 'test-user-a',
      memberIds: ['test-user-a', 'test-user-b', 'test-user-c'],
    });
  }
}

async function main() {
  const { store, mode } = await createStore(config, log);
  log.info(`[store] 存储模式: ${mode}`);

  // memory 模式注入演示群（联调用）
  if (mode === 'memory') {
    await seedDemoConversation(store, config);
    const c = await store.getConversation('conv-demo');
    if (c) log.info(`[seed] 演示会话 ${c.id}（成员: test-user-a/b/c）`);
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'im-server',
        store: mode,
        onlineCount: require('./presence').onlineUserIds().length,
        time: new Date().toISOString(),
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'not found' }));
  });

  const io = createIo(httpServer, { store, config, log });

  // PG LISTEN/NOTIFY（§9.4）
  const listener = startListener({ config, io, store, log });

  const graceful = () => {
    log.info('收到退出信号，关闭服务…');
    if (listener) listener.close();
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);

  httpServer.listen(config.PORT, () => {
    log.info(`IM 服务已启动: http://0.0.0.0:${config.PORT}`);
    log.info(`  Socket.IO 端点: ws://localhost:${config.PORT}?token=<JWT>`);
    log.info(`  健康检查: http://localhost:${config.PORT}/health`);
    if (!config.JWT_SECRET) {
      log.warn('未检测到 JWT_SECRET（也未从主服务 .env 读取到），握手鉴权将全部失败。请设置 JWT_SECRET 或 SECRET。');
    }
  });
}

main().catch((e) => {
  log.error('启动失败:', e);
  process.exit(1);
});
