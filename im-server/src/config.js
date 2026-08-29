'use strict';

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// 按优先级加载 .env：im-server/.env > 主服务 .env > 主服务 .env.local > 已有 process.env
// dotenv 不会覆盖已存在的环境变量，因此先加载的优先。
const __srcDir = __dirname;
const envFiles = [
  path.join(__srcDir, '..', '.env'),            // im-server/.env
  path.join(__srcDir, '..', '..', '.env'),      // 主服务 .env
  path.join(__srcDir, '..', '..', '.env.local'),// 主服务 .env.local
];
for (const p of envFiles) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
  }
}

// JWT 密钥：与主服务 src/lib/auth.ts 同一套（JWT_SECRET，兼容别名 SECRET）
const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || '';

const config = {
  PORT: Number(process.env.IM_PORT || process.env.PORT || 3002),
  JWT_SECRET,
  DATABASE_URL: process.env.IM_DATABASE_URL || process.env.DATABASE_URL || '',
  STORE: (process.env.IM_STORE || 'auto').toLowerCase(), // auto | memory | prisma
  HEARTBEAT_MS: Number(process.env.IM_HEARTBEAT_MS || 30000),
  HEARTBEAT_TIMEOUT_MS: Number(process.env.IM_HEARTBEAT_TIMEOUT_MS || 10000),
  NOTIFY_CHANNEL: process.env.IM_NOTIFY_CHANNEL || 'im_events',
  SEED_DEMO: (process.env.IM_SEED_DEMO || 'true').toLowerCase() !== 'false',
  ROOM_CONV: (id) => `conv:${id}`,
  ROOM_USER: (id) => `user:${id}`,
};

module.exports = config;
