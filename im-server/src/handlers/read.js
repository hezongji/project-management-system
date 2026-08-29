'use strict';

const { CLIENT, SERVER } = require('../events');

/**
 * 已读上报：read:ack（落库）→ 广播 read:sync。
 */
function registerReadHandler(ctx, socket) {
  const { io, store, config } = ctx;
  const user = socket.data.user;

  socket.on(CLIENT.READ_ACK, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    try {
      const { conversationId, lastReadAt } = payload;
      if (!conversationId) return reply(false, { error: 'missing conversationId' });
      if (!(await store.isMember(conversationId, user.userId))) {
        return reply(false, { error: 'forbidden: not a member' });
      }

      await store.markRead(conversationId, user.userId, lastReadAt ? new Date(lastReadAt) : new Date());

      // 群已读同步（轻量）：当前仅回推该用户
      io.to(config.ROOM_CONV(conversationId)).emit(SERVER.READ_SYNC, {
        conversationId,
        userIds: [user.userId],
      });

      return reply(true);
    } catch (e) {
      ctx.log.error('[read:ack]', e.message);
      return reply(false, { error: e.message });
    }
  });
}

module.exports = { registerReadHandler };
