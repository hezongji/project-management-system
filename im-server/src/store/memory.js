'use strict';

/**
 * 内存存储实现（骨架默认 / 联调用）。
 * 与 PrismaStore 实现同一接口，保证联调脚本无需 PG 即可完整跑通。
 */
class MemoryStore {
  constructor() {
    this.conversations = new Map(); // id -> conversation
    this.members = new Map();       // conversationId -> Map(userId -> member)
    this.messages = new Map();      // conversationId -> Message[]（按 createdAt 升序）
    this.notifications = [];        // Notification[]（内存态，联调用）
    this.todos = [];                // TodoItem[]（内存态，联调用）
  }

  /* ---------- 会话 ---------- */
  async createConversation({ id, type = 'GROUP', name = null, projectId = null, createdBy = 'system', memberIds = [] }) {
    id = id || this._id('conv');
    const now = new Date();
    const conversation = {
      id, type, name, avatar: null, projectId, createdBy,
      lastMessageAt: now, createdAt: now,
    };
    if (this.conversations.has(id)) return { ...this.conversations.get(id) };
    this.conversations.set(id, conversation);
    this.members.set(id, new Map());
    this.messages.set(id, []);
    const unique = [...new Set([createdBy, ...memberIds])].filter(Boolean);
    for (const uid of unique) {
      this.members.get(id).set(uid, {
        id: this._id('mem'), conversationId: id, userId: uid,
        role: uid === createdBy ? 'OWNER' : 'MEMBER',
        lastReadAt: null, muted: false, joinedAt: now,
      });
    }
    return conversation;
  }

  async getConversation(id) {
    const c = this.conversations.get(id);
    return c ? { ...c } : null;
  }

  async listConversationsForUser(userId) {
    const out = [];
    for (const [cid, memberMap] of this.members) {
      if (memberMap.has(userId)) {
        const c = this.conversations.get(cid);
        if (c) out.push({ ...c });
      }
    }
    return out;
  }

  async isMember(conversationId, userId) {
    const m = this.members.get(conversationId);
    return !!(m && m.has(userId));
  }

  async listMembers(conversationId) {
    const m = this.members.get(conversationId);
    if (!m) return [];
    return [...m.values()].map((x) => ({ ...x }));
  }

  async touchConversation(conversationId) {
    const c = this.conversations.get(conversationId);
    if (c) c.lastMessageAt = new Date();
  }

  /* ---------- 消息 ---------- */
  async createMessage({ conversationId, senderId, senderName = null, type = 'TEXT', content = '', replyToId = null, fileMeta = null, mentions = null }) {
    const msg = {
      id: this._id('msg'),
      conversationId,
      senderId,
      senderName,
      type,
      content,
      replyToId,
      fileMeta,
      mentions,
      revoked: false,
      createdAt: new Date(),
    };
    const arr = this.messages.get(conversationId);
    if (!arr) throw new Error(`conversation not found: ${conversationId}`);
    arr.push(msg);
    return { ...msg };
  }

  async getMessages(conversationId, { before = null, limit = 50 } = {}) {
    let arr = this.messages.get(conversationId) || [];
    arr = [...arr].sort((a, b) => a.createdAt - b.createdAt);
    if (before) arr = arr.filter((m) => m.createdAt < new Date(before));
    return arr.slice(-limit).map((m) => ({ ...m }));
  }

  async getMessage(messageId) {
    for (const arr of this.messages.values()) {
      const m = arr.find((x) => x.id === messageId);
      if (m) return { ...m };
    }
    return null;
  }

  async revokeMessage(messageId) {
    for (const arr of this.messages.values()) {
      const m = arr.find((x) => x.id === messageId);
      if (m) { m.revoked = true; return { ...m }; }
    }
    return null;
  }

  /* ---------- 通知与待办 ---------- */
  async writeNotification({ userId, type, title, body = null, link = null }) {
    const n = {
      id: this._id('notif'), userId, type, title, body, link,
      isRead: false, createdAt: new Date(),
    };
    this.notifications.push(n);
    return { ...n };
  }

  async writeTodo({ userId, title, sourceType = 'MANUAL', sourceId = null, link = null, priority = 'MEDIUM' }) {
    const t = {
      id: this._id('todo'), userId, title, sourceType, sourceId, link,
      dueAt: null, doneAt: null, priority, createdAt: new Date(),
    };
    this.todos.push(t);
    return { ...t };
  }

  /* ---------- 已读 ---------- */
  async markRead(conversationId, userId, lastReadAt = new Date()) {
    const m = this.members.get(conversationId);
    if (m && m.has(userId)) {
      m.get(userId).lastReadAt = lastReadAt;
    }
    return true;
  }

  /* ---------- 工具 ---------- */
  _id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

module.exports = MemoryStore;
