'use strict';

// 事件名（对照开发文档 §9.2 事件表）

// C → S（客户端 → 服务端）
const CLIENT = {
  MESSAGE_SEND: 'message:send',     // {conversationId, type, content, replyToId?, fileMeta?, mentions?}
  MESSAGE_REVOKE: 'message:revoke', // {messageId}
  TYPING: 'typing',                 // {conversationId, userId, name}
  READ_ACK: 'read:ack',             // {conversationId, lastReadAt}
  CONV_JOIN: 'conversation:join',   // {conversationId}（骨架扩展：手动入房）
  CONV_LEAVE: 'conversation:leave', // {conversationId}（骨架扩展：手动退房）
  CONV_CREATE: 'conversation:create', // {type, name, memberIds}（骨架扩展：正式由主服务 REST 建群）
};

// S → C（服务端 → 客户端）
const SERVER = {
  MESSAGE_NEW: 'message:new',       // {message, conversationId}
  READ_SYNC: 'read:sync',           // {conversationId, userIds:[]}
  PRESENCE_SYNC: 'presence:sync',   // {conversationId, onlineUserIds:[]}
  CONV_CREATED: 'conv:created',     // {conversation}
  NOTIFY_PUSH: 'notify:push',       // {title, body, link}
  TODO_PUSH: 'todo:push',           // {todoItem}
};

// 心跳（应用层；引擎层另有 pingInterval/pingTimeout）
const HEARTBEAT = {
  PING: 'ping',
  PONG: 'pong',
};

module.exports = { CLIENT, SERVER, HEARTBEAT };
