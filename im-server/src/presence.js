'use strict';

const { SERVER } = require('./events');

/**
 * 在线状态跟踪（内存态）。
 * online: Map<userId, Set<socketId>>
 */
const online = new Map();

function addOnline(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}

function removeOnline(userId, socketId) {
  const set = online.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    online.delete(userId);
    return true; // 该用户已完全离线
  }
  return false;
}

function isOnline(userId) {
  return online.has(userId) && online.get(userId).size > 0;
}

function onlineUserIds() {
  return [...online.keys()];
}

/** 某用户的在线 socketId 列表（供 NOTIFY 处理时服务端主动入房） */
function socketIdsOf(userId) {
  return [...(online.get(userId) || [])];
}

/**
 * 向某会话房间广播在线列表（§9.2 presence:sync）。
 */
async function broadcastPresence(io, store, conversationId) {
  const members = await store.listMembers(conversationId);
  const onlineUserIds = members
    .map((m) => m.userId)
    .filter((uid) => isOnline(uid));
  io.to(`conv:${conversationId}`).emit(SERVER.PRESENCE_SYNC, {
    conversationId,
    onlineUserIds,
  });
}

/**
 * 广播某用户所属的所有会话房间的在线列表。
 */
async function broadcastPresenceForUser(io, store, userId) {
  const convs = await store.listConversationsForUser(userId);
  await Promise.all(convs.map((c) => broadcastPresence(io, store, c.id)));
}

module.exports = {
  addOnline,
  removeOnline,
  isOnline,
  onlineUserIds,
  socketIdsOf,
  broadcastPresence,
  broadcastPresenceForUser,
};
