'use strict';

const MemoryStore = require('./memory');

/**
 * 存储工厂：根据 IM_STORE 返回 memory / prisma 实现。
 * auto：优先 prisma（需 PG 且表已建），失败回退 memory。
 */
async function createStore(config, log = console) {
  const mode = config.STORE;

  if (mode === 'memory') {
    return { store: new MemoryStore(), mode: 'memory' };
  }

  if (mode === 'prisma') {
    const { createPrismaStore } = require('./prisma');
    const store = await createPrismaStore(config);
    return { store, mode: 'prisma' };
  }

  // auto
  if (config.DATABASE_URL && config.DATABASE_URL.startsWith('postgres')) {
    try {
      const { createPrismaStore } = require('./prisma');
      const store = await createPrismaStore(config);
      return { store, mode: 'prisma' };
    } catch (e) {
      log.warn(`[store] prisma 不可用（${e.message}），回退 memory 存储`);
    }
  }
  return { store: new MemoryStore(), mode: 'memory' };
}

module.exports = { createStore };
