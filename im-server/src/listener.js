'use strict';

const { Client } = require('pg');
const { SERVER } = require('./events');
const presence = require('./presence');

/**
 * PG LISTEN/NOTIFY 监听器（§9.4）。
 * 主服务写库后通过 `NOTIFY im_events, '{...}'` 通知；IM 服务 LISTEN 后拉取并广播，
 * 保证 REST 建群 / 系统消息与实时通道一致。
 *
 * 仅在 PG 模式下启动；memory 模式下跳过。
 */
function startListener({ config, io, store, log = console }) {
  if (!config.DATABASE_URL || !config.DATABASE_URL.startsWith('postgres')) {
    log.info('[notify] 未配置 PG，跳过 LISTEN/NOTIFY（memory 模式）');
    return null;
  }

  const client = new Client({ connectionString: config.DATABASE_URL });
  let stopping = false;

  client.on('notification', async (msg) => {
    if (msg.channel !== config.NOTIFY_CHANNEL) return;
    let payload;
    try {
      payload = JSON.parse(msg.payload || '{}');
    } catch {
      log.warn('[notify] 无法解析 payload:', msg.payload);
      return;
    }
    try {
      await handleNotify(payload);
    } catch (e) {
      log.error('[notify] 处理失败:', e.message);
    }
  });

  client.on('error', (err) => {
    log.error('[notify] PG 连接错误:', err.message);
    if (!stopping) reconnect();
  });

  async function handleNotify(payload) {
    const { event, conversationId, conversation, userId } = payload;
    switch (event) {
      case 'message:new': {
        // 主服务（REST 建群/系统消息等）落库后触发；IM 拉取最新一条广播
        if (!conversationId) return;
        const messages = await store.getMessages(conversationId, { limit: 1 });
        const message = messages && messages[messages.length - 1];
        if (message) {
          io.to(config.ROOM_CONV(conversationId)).emit(SERVER.MESSAGE_NEW, { message, conversationId });
        }
        break;
      }
      case 'conv:created': {
        // 被拉入新会话（建项目群时）：对全部成员推送 conv:created，
        // 并服务端主动把【在线】成员拉入会话房间，保证紧随其后的 message:new
        // （欢迎消息）能实时广播到他们（连接时恢复订阅只覆盖已存在的会话，
        // 新建会话必须由本事件补入房）。
        if (conversation && conversation.id) {
          const members = Array.isArray(conversation.members)
            ? conversation.members
            : [];
          for (const m of members) {
            const uid = m && m.userId;
            if (!uid) continue;
            for (const sid of presence.socketIdsOf(uid)) {
              const s = io.sockets.sockets.get(sid);
              if (s) s.join(config.ROOM_CONV(conversation.id));
            }
            io.to(config.ROOM_USER(uid)).emit(SERVER.CONV_CREATED, { conversation });
          }
        }
        break;
      }
      case 'read:sync': {
        // REST 标读（POST /api/conversations/:id/read）落库后广播已读同步（§9.2 read:sync）
        if (conversationId && userId) {
          io.to(config.ROOM_CONV(conversationId)).emit(SERVER.READ_SYNC, {
            conversationId,
            userIds: [userId],
          });
        }
        break;
      }
      case 'notify:push': {
        if (userId) {
          io.to(config.ROOM_USER(userId)).emit(SERVER.NOTIFY_PUSH, {
            title: payload.title, body: payload.body, link: payload.link,
          });
        }
        break;
      }
      case 'todo:push': {
        if (userId && payload.todoItem) {
          io.to(config.ROOM_USER(userId)).emit(SERVER.TODO_PUSH, { todoItem: payload.todoItem });
        }
        break;
      }
      default:
        log.debug('[notify] 未知事件:', event);
    }
  }

  function reconnect() {
    if (stopping) return;
    setTimeout(async () => {
      if (stopping) return;
      try {
        await client.connect();
        await client.query(`LISTEN ${config.NOTIFY_CHANNEL}`);
        log.info('[notify] LISTEN/NOTIFY 已重连:', config.NOTIFY_CHANNEL);
      } catch (e) {
        log.error('[notify] 重连失败:', e.message);
        reconnect();
      }
    }, 3000);
  }

  client.connect()
    .then(() => client.query(`LISTEN ${config.NOTIFY_CHANNEL}`))
    .then(() => log.info(`[notify] LISTEN ${config.NOTIFY_CHANNEL} 成功`))
    .catch((e) => {
      log.error('[notify] LISTEN 初始化失败:', e.message);
      reconnect();
    });

  return {
    close: () => {
      stopping = true;
      return client.end().catch(() => {});
    },
  };
}

module.exports = { startListener };
