'use strict';

const { CLIENT, SERVER } = require('../events');
const presence = require('../presence');

/**
 * 会话房间：join/leave/create。
 * - conversation:join / conversation:leave：手动进/退房（骨架扩展）
 * - conversation:create：建群（骨架扩展，正式由主服务 REST + NOTIFY 驱动）
 * 连接建立时也会自动 join 其所有会话（见 server.js 的恢复订阅逻辑）。
 */
function registerConversationHandlers(ctx, socket) {
  const { io, store, config } = ctx;
  const user = socket.data.user;

  socket.on(CLIENT.CONV_JOIN, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    const { conversationId } = payload;
    if (!conversationId) return reply(false, { error: 'missing conversationId' });
    if (!(await store.isMember(conversationId, user.userId))) {
      return reply(false, { error: 'forbidden: not a member' });
    }
    socket.join(config.ROOM_CONV(conversationId));
    await presence.broadcastPresence(io, store, conversationId);
    return reply(true);
  });

  socket.on(CLIENT.CONV_LEAVE, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    const { conversationId } = payload;
    if (!conversationId) return reply(false, { error: 'missing conversationId' });
    socket.leave(config.ROOM_CONV(conversationId));
    return reply(true);
  });

  socket.on(CLIENT.CONV_CREATE, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    try {
      const conversation = await store.createConversation({
        type: payload.type || 'GROUP',
        name: payload.name || null,
        projectId: payload.projectId || null,
        createdBy: user.userId,
        memberIds: Array.isArray(payload.memberIds) ? payload.memberIds : [],
      });
      // 创建者入房；其余成员在线时通过 user 房间推送 conv:created
      socket.join(config.ROOM_CONV(conversation.id));
      const members = await store.listMembers(conversation.id);
      for (const m of members) {
        io.to(config.ROOM_USER(m.userId)).emit(SERVER.CONV_CREATED, { conversation });
      }
      return reply(true, { conversation });
    } catch (e) {
      ctx.log.error('[conversation:create]', e.message);
      return reply(false, { error: e.message });
    }
  });
}

module.exports = { registerConversationHandlers };
