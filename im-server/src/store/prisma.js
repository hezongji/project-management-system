'use strict';

const { PrismaClient } = require('@prisma/client');

/**
 * PG 存储实现（生产路径）。与主服务共享 conversations / conversation_members / messages 表。
 * 使用 im-server/prisma/schema.prisma 生成的 Client。
 */
class PrismaStore {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async createConversation({ id, type = 'GROUP', name = null, projectId = null, createdBy = 'system', memberIds = [] }) {
    const unique = [...new Set([createdBy, ...memberIds])].filter(Boolean);
    const conversation = await this.prisma.conversation.create({
      data: {
        ...(id ? { id } : {}),
        type: type.toUpperCase(),
        name,
        projectId,
        createdBy,
        members: {
          create: unique.map((uid) => ({ userId: uid, role: uid === createdBy ? 'OWNER' : 'MEMBER' })),
        },
      },
      include: { members: true },
    });
    return conversation;
  }

  async getConversation(id) {
    return this.prisma.conversation.findUnique({ where: { id }, include: { members: true } });
  }

  async listConversationsForUser(userId) {
    return this.prisma.conversation.findMany({
      where: { members: { some: { userId } } },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async isMember(conversationId, userId) {
    const m = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    return !!m;
  }

  async listMembers(conversationId) {
    return this.prisma.conversationMember.findMany({ where: { conversationId } });
  }

  async touchConversation(conversationId) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
  }

  async createMessage({ conversationId, senderId, senderName = null, type = 'TEXT', content = '', replyToId = null, fileMeta = null, mentions = null }) {
    return this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        type: type.toUpperCase(),
        content,
        replyToId,
        fileMeta: fileMeta || undefined,
        mentions: mentions || undefined,
      },
      // 补 sender 关系，桌面通知/消息列表可直接取发件人（P4 P2-2）
      include: {
        sender: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });
  }

  async getMessages(conversationId, { before = null, limit = 50 } = {}) {
    return this.prisma.message.findMany({
      where: {
        conversationId,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getMessage(id) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  async revokeMessage(messageId) {
    return this.prisma.message.update({
      where: { id: messageId },
      data: { revoked: true },
    });
  }

  async writeNotification({ userId, type, title, body = null, link = null }) {
    return this.prisma.notification.create({
      data: { userId, type, title, body, link },
    });
  }

  async writeTodo({ userId, title, sourceType = 'MANUAL', sourceId = null, link = null, priority = 'MEDIUM' }) {
    return this.prisma.todoItem.create({
      data: { userId, title, sourceType, sourceId, link, priority },
    });
  }

  async markRead(conversationId, userId, lastReadAt = new Date()) {
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt },
    });
    return true;
  }
}

async function createPrismaStore(config) {
  if (!config.DATABASE_URL || !config.DATABASE_URL.startsWith('postgres')) {
    throw new Error('DATABASE_URL 非 postgresql，无法启用 prisma 存储');
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
  });
  await prisma.$connect();
  // 快速探测 IM 表是否已由主 schema 建立（共享库时由 P0-1 创建）
  const hasTables = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Conversation','ConversationMember','Message')"
  );
  const n = Number(hasTables?.[0]?.n ?? 0);
  if (n < 3) {
    await prisma.$disconnect();
    throw new Error(`IM 表缺失（${n}/3）。请先在主 schema 建表，或独立部署时运行 npm run prisma:push`);
  }
  return new PrismaStore(prisma);
}

module.exports = { PrismaStore, createPrismaStore };
