'use strict';

const jwt = require('jsonwebtoken');
const config = require('./config');

/**
 * 验证 JWT，返回 { userId, email, role, name }；无效返回 null。
 * 与主服务 src/lib/auth.ts 的 verifyAuthToken 保持同一载荷约定（HS256）。
 */
function verifyToken(token) {
  if (!token) return null;
  if (!config.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (!payload || !payload.userId) return null;
    return {
      userId: payload.userId,
      email: payload.email || payload.userId,
      role: payload.role || 'USER',
      name: payload.name || payload.email || payload.userId,
    };
  } catch {
    return null;
  }
}

/**
 * 从 Socket.IO 握手信息中提取 token（§9.1：URL ?token=<JWT>，兼容 Bearer / auth.token）
 */
function extractToken(handshake) {
  const query = handshake.query || {};
  const auth = handshake.auth || {};
  const headers = handshake.headers || {};

  if (typeof query.token === 'string' && query.token) return query.token;
  if (typeof auth.token === 'string' && auth.token) return auth.token;

  const authorization = headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.substring(7);

  return null;
}

module.exports = { verifyToken, extractToken };
