'use strict';

/**
 * 生成测试 JWT（与主服务同密钥），供 wscat / socket.io-client 联调用。
 *
 * 用法：
 *   node scripts/gen-test-token.js                    # 默认 test-user-a
 *   node scripts/gen-test-token.js test-user-b b@test.dev USER
 *   node scripts/gen-test-token.js <userId> <email> <role> [name]
 */
const jwt = require('jsonwebtoken');
const config = require('../src/config');

if (!config.JWT_SECRET) {
  console.error('未找到 JWT_SECRET。请设置环境变量 JWT_SECRET，或确保主服务 .env 存在。');
  process.exit(1);
}

const userId = process.argv[2] || 'test-user-a';
const email = process.argv[3] || `${userId}@test.dev`;
const role = process.argv[4] || 'USER';
const name = process.argv[5] || userId;

const token = jwt.sign(
  { userId, email, role, name },
  config.JWT_SECRET,
  { expiresIn: '30d' }
);

console.log(`userId: ${userId}`);
console.log(`email : ${email}`);
console.log(`role  : ${role}`);
console.log(`token : ${token}`);
console.log(`\nSocket.IO 连接示例:`);
console.log(`  ws://localhost:${config.PORT}?token=${token}`);
