'use strict';

const { CLIENT, SERVER } = require('../events');

/**
 * 正在输入：转发给同会话其余成员。
 */
function registerTypingHandler(ctx, socket) {
  const { io, store, config } = ctx;
  const user = socket.data.user;

  socket.on(CLIENT.TYPING, async (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;
    if (!(await store.isMember(conversationId, user.userId))) return;

    socket.to(config.ROOM_CONV(conversationId)).emit(CLIENT.TYPING, {
      conversationId,
      userId: user.userId,
      name: user.name || user.email || user.userId,
    });
  });
}

module.exports = { registerTypingHandler };
