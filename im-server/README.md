# im-server — IM 即时通讯服务（独立进程）

Socket.IO 独立服务，与 Next.js 主服务分离，监听 `:3002`。对应开发文档 §2（目录结构）、§9（IM 协议）。

## 目录结构

```
im-server/
├─ package.json            # socket.io / pg / jsonwebtoken / dotenv + prisma(@prisma/client)
├─ .env.example
├─ prisma/schema.prisma    # IM 子集模型（conversations / conversation_members / messages）
├─ src/
│  ├─ index.js             # 入口：HTTP 健康检查 + 启动/优雅退出 + 演示数据注入
│  ├─ config.js            # 环境变量（含回退读取主服务 .env 的 JWT 密钥）
│  ├─ auth.js              # JWT 验证（与主服务同密钥/同载荷）
│  ├─ events.js            # §9.2 事件名常量
│  ├─ server.js            # Socket.IO 服务：鉴权中间件 + 恢复订阅 + 心跳
│  ├─ listener.js          # PG LISTEN/NOTIFY（im_events 通道，§9.4）
│  ├─ presence.js          # 在线状态 + presence:sync 广播
│  ├─ store/
│  │  ├─ index.js          # 存储工厂（auto|memory|prisma）
│  │  ├─ memory.js         # 内存实现（骨架默认 / 联调）
│  │  └─ prisma.js         # PG 实现（生产，共享主 schema 表）
│  └─ handlers/
│     ├─ message.js        # message:send / message:revoke
│     ├─ typing.js         # typing 转发
│     ├─ read.js           # read:ack / read:sync
│     └─ conversation.js   # conversation:join/leave/create
└─ scripts/
   ├─ gen-test-token.js    # 生成测试 JWT
   └─ test-e2e.js          # 端到端联调脚本（双 token / 收发 / 重连）
```

## 快速开始

```bash
cd im-server
npm install
npm run dev                 # 启动 :3002（默认 memory 存储，自动注入 conv-demo 演示群）
```

另一终端联调：

```bash
npm run gen-token           # 生成测试 JWT（默认 test-user-a）
npm run test:e2e            # 端到端验收（连接/收发/typing/presence/重连/非法token）
```

## 连接鉴权（§9.1）

```
ws://localhost:3002?token=<JWT>     # 或 auth:{token} 或 Authorization: Bearer <JWT>
```

- JWT 与主服务共用同一密钥（`JWT_SECRET`/`SECRET`），载荷 `{userId, email, role, name?}`。
- 握手失败 → `disconnect('unauthorized')`。
- 连接后自动 join `conv:{conversationId}`（其成员）与 `user:{userId}`。

## 事件（§9.2）

| 方向 | 事件 | 说明 |
|------|------|------|
| C→S | `message:send` | 校验成员 → 落库 → 广播 |
| C→S | `message:revoke` | 撤回（骨架不强制 2 分钟） |
| C→S | `typing` | 正在输入 |
| C→S | `read:ack` | 已读上报 |
| C→S | `conversation:join/leave/create` | 骨架扩展（正式建群走主服务 REST） |
| S→C | `message:new` | 新消息 `{message, conversationId}` |
| S→C | `read:sync` | 已读同步 `{conversationId, userIds}` |
| S→C | `presence:sync` | 在线列表 `{conversationId, onlineUserIds}` |
| S→C | `conv:created` / `notify:push` / `todo:push` | 通知类 |

## 存储模式

| IM_STORE | 说明 |
|----------|------|
| `memory`（默认） | 内存实现，无需数据库，用于骨架/联调 |
| `prisma` | PG 实现，共享主服务 `conversations`/`conversation_members`/`messages` 表 |
| `auto` | 有可用 PG 表用 prisma，否则回退 memory |

PG 模式：

```bash
# .env
IM_DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/pm_dev
IM_STORE=prisma
```

> 共享库时表由主 schema（P0-1）建立，im-server 只复用不建表；独立部署时 `npm run prisma:generate && npm run prisma:push` 建 IM 表。

## PG LISTEN/NOTIFY（§9.4）

- 主服务写库后 `NOTIFY im_events, '{...}'`；im-server `LISTEN im_events` → 拉取并广播。
- 支持 `message:new` / `conv:created` / `notify:push` / `todo:push` 四类通知。
- 仅在 PG 模式下启动；断线自动重连。

## 心跳 / 重连

- 引擎级 `pingInterval=30s` / `pingTimeout=10s`（Socket.IO 内置心跳）。
- 应用层另提供 `ping`/`pong` 事件。
- 断线重连后：服务端据存储成员关系重新 join 其所有会话房间，自动恢复订阅。
