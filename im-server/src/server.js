'use strict';

const { Server } = require('socket.io');
const { verifyToken, extractToken } = require('./auth');
const { HEARTBEAT } = require('./events');
const presence = require('./presence');
const { registerMessageHandlers } = require('./handlers/message');
const { registerTypingHandler } = require('./handlers/typing');
const { registerReadHandler } = require('./handlers/read');
const { registerConversationHandlers } = require('./handlers/conversation');

/**
 * 构建并启动 Socket.IO 服务。
 * @param {http.Server} httpServer
 * @param {object} deps { store, config, log }
 * @returns {Server}
 */
function createIo(httpServer, { store, config, log = console }) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',')
        : true,
      credentials: true,
    },
    // 引擎级心跳：30s ping / 10s timeout（§9 心跳要求）
    pingInterval: config.HEARTBEAT_MS,
    pingTimeout: config.HEARTBEAT_TIMEOUT_MS,
  });

  // ── 鉴权中间件（§9.1：握手失败 → unauthorized）──
  io.use((socket, next) => {
    const token = extractToken(socket.handshake);
    const user = verifyToken(token);
    if (!user) {
      log.warn(`[auth] 拒绝连接: token=${token ? '验签失败:' + token.slice(0, 25) + '... handshake.auth键:' + Object.keys(socket.handshake.auth || {}) + ' query键:' + Object.keys(socket.handshake.query || {}) : '未提供'}`);
      return next(new Error('unauthorized'));
    }
    socket.data.user = user;
    next();
  });

  const ctx = { io, store, config, log };

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    log.info(`[io] 连接: ${user.userId} (${socket.id})`);
    // ★ SDLC F-007 修复: handler 注册前置, 消除 connection 回调异步链期间的事件丢失窗口
    registerMessageHandlers(ctx, socket);
    registerTypingHandler(ctx, socket);
    registerReadHandler(ctx, socket);
    registerConversationHandlers(ctx, socket);

    // 1) 全局房间 user:{userId}
    socket.join(config.ROOM_USER(user.userId));

    // 2) 恢复订阅：加入其所属的所有会话房间（断线重连后自动恢复）
    try {
      const convs = await store.listConversationsForUser(user.userId);
      for (const c of convs) socket.join(config.ROOM_CONV(c.id));
    } catch (e) {
      log.error('[io] 恢复订阅失败:', e.message);
    }

    // 3) 在线登记 + 广播 presence
    presence.addOnline(user.userId, socket.id);
    await presence.broadcastPresenceForUser(io, store, user.userId);

    // 4) 应用层心跳（引擎层之外再提供 ping/pong）
    socket.on(HEARTBEAT.PING, () => socket.emit(HEARTBEAT.PONG, { ts: Date.now() }));

    // 5) 业务事件

    socket.on('disconnect', async () => {
      const becameOffline = presence.removeOnline(user.userId, socket.id);
      log.info(`[io] 断开: ${user.userId} (${socket.id})${becameOffline ? '（完全离线）' : ''}`);
      if (becameOffline) {
        await presence.broadcastPresenceForUser(io, store, user.userId);
      }
    });

    // 上线即向自己回推一次在线列表（方便前端初始化）
    socket.emit('connected', {
      userId: user.userId,
      email: user.email,
      role: user.role,
      serverTime: new Date().toISOString(),
    });
  });

  return io;
}

module.exports = { createIo };
