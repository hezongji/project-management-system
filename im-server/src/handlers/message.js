'use strict';

const { CLIENT, SERVER } = require('../events');

/**
 * 消息处理：message:send（校验成员 → 落库 → 广播）、message:revoke。
 * @param {object} ctx { io, store, config, log }
 */
function registerMessageHandlers(ctx, socket) {
  const { io, store, config } = ctx;
  const user = socket.data.user;
  const REVOKE_WINDOW_MS = 2 * 60 * 1000; // §9.2：撤回窗口 2 分钟

  socket.on(CLIENT.MESSAGE_SEND, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    try {
      const { conversationId } = payload;
      if (!conversationId) return reply(false, { error: 'missing conversationId' });

      const isMember = await store.isMember(conversationId, user.userId);
      if (!isMember) return reply(false, { error: 'forbidden: not a member' });

      const message = await store.createMessage({
        conversationId,
        senderId: user.userId,
        senderName: user.name || user.email || user.userId,
        type: (payload.type || 'TEXT').toUpperCase(),
        content: payload.content ?? '',
        replyToId: payload.replyToId ?? null,
        fileMeta: payload.fileMeta ?? null,
        mentions: payload.mentions ?? null,
      });
      await store.touchConversation(conversationId);

      // 广播到目标会话房间
      io.to(config.ROOM_CONV(conversationId)).emit(SERVER.MESSAGE_NEW, { message, conversationId });

      // @提及 → 落库 Notification + TodoItem，并推 notify:push + todo:push（§9.2 message:new）
      if (Array.isArray(payload.mentions) && payload.mentions.length) {
        const senderLabel = user.name || user.email || user.userId;
        const link = `/messages?conversation=${conversationId}`;
        for (const mentionedId of payload.mentions) {
          if (!mentionedId) continue;

          // 1) Notification 落库 + notify:push
          try {
            await store.writeNotification({
              userId: mentionedId,
              type: 'MENTION',
              title: '有人@你',
              body: `${senderLabel} 在会话中提到了你`,
              link,
            });
          } catch (e) {
            ctx.log.error('[message:send] writeNotification:', e.message);
          }
          io.to(config.ROOM_USER(mentionedId)).emit(SERVER.NOTIFY_PUSH, {
            title: '有人@你',
            body: `${senderLabel} 在会话中提到了你`,
            link,
          });

          // 2) TodoItem 落库 + todo:push
          // v1.2 W1 守卫：mentions>20（@所有人/大群）只写 Notification 跳过 TodoItem，
          // 避免待办洪泛（Notification 保留不动）
          if (Array.isArray(payload.mentions) && payload.mentions.length <= 20) {
            try {
              const todoItem = await store.writeTodo({
                userId: mentionedId,
                title: `${senderLabel} 在会话中@了你`,
                sourceType: 'MESSAGE',
                sourceId: message.id,
                link,
                priority: 'MEDIUM',
              });
              io.to(config.ROOM_USER(mentionedId)).emit(SERVER.TODO_PUSH, { todoItem });
            } catch (e) {
              ctx.log.error('[message:send] writeTodo:', e.message);
            }
          }
        }
      }

      return reply(true, { message });
    } catch (e) {
      ctx.log.error('[message:send]', e.message);
      return reply(false, { error: e.message });
    }
  });

  socket.on(CLIENT.MESSAGE_REVOKE, async (payload = {}, ack) => {
    const reply = (ok, extra) => (typeof ack === 'function' ? ack({ ok, ...extra }) : null);
    try {
      const { messageId } = payload;
      if (!messageId) return reply(false, { error: 'missing messageId' });

      const existing = await store.getMessage(messageId);
      if (!existing) return reply(false, { error: 'message not found' });
      // §9.2：仅发送者本人可撤回自己的消息
      if (existing.senderId !== user.userId) {
        return reply(false, { error: 'forbidden: not the sender' });
      }
      if (existing.revoked) {
        return reply(false, { error: 'message already revoked' });
      }
      // §9.2：2 分钟内可撤回，超时拒绝
      const elapsed = Date.now() - new Date(existing.createdAt).getTime();
      if (elapsed > REVOKE_WINDOW_MS) {
        return reply(false, { error: 'exceed 2 minutes revoke window' });
      }

      const message = await store.revokeMessage(messageId);
      io.to(config.ROOM_CONV(message.conversationId)).emit(SERVER.MESSAGE_NEW, {
        message, conversationId: message.conversationId, revoked: true,
      });
      return reply(true, { message });
    } catch (e) {
      ctx.log.error('[message:revoke]', e.message);
      return reply(false, { error: e.message });
    }
  });
}

module.exports = { registerMessageHandlers };
