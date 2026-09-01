# 部署文档

本文档覆盖项目管理系统从零到上线的完整流程。系统由四类服务组成：

| 服务 | 作用 | 端口（容器内） |
|------|------|----------------|
| `postgres` | PostgreSQL 16 数据库 | 5432 |
| `app` | Next.js 主服务（页面 + REST API） | 3000 |
| `im` | Socket.IO 即时通讯（独立进程） | 3002 |
| `nginx` / `caddy` | 反向代理（HTTP / 自动 HTTPS） | 80 / 443 |

推荐使用一键部署脚本 `deploy/install.sh`，它会自动完成依赖检测、`.env` 生成、容器启动与数据库迁移。

---

## 1. 前置要求

- Linux 服务器（推荐 Debian / Ubuntu，2 核 2G 起步）
- Docker ≥ 24（含 Compose v2 插件）
- 一个域名（仅 HTTPS 模式必需）
- 放行防火墙端口：80（HTTP）、443（HTTPS），可选 5432（数据库，建议仅内网）

安装 Docker（以 Ubuntu 为例）：

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # 重新登录后生效，免 sudo 运行 docker
```

---

## 2. 快速开始（一键部署）

```bash
# 1. 获取代码
git clone https://github.com/hezongji/project-management-system.git
cd project-management-system

# 2. 一键部署（HTTP 模式，交互询问站点地址）
./deploy/install.sh

# 或：HTTPS 模式（Caddy 自动签发 Let's Encrypt 证书）
./deploy/install.sh --https --domain pm.example.com

# 或：全自动（非交互，默认 http://localhost）
./deploy/install.sh --non-interactive
```

脚本会依次完成：

1. 检测 docker / docker compose 及 daemon 运行状态
2. 生成 `.env`（基于 `.env.example`，自动注入强随机密钥，每个变量带注释）
3. 创建必要目录（证书、APK 分发）
4. 校验并启动容器（postgres + app + im + 反向代理）
5. 执行数据库迁移 `prisma migrate deploy`
6. 打印访问地址与常用运维命令

> 脚本**幂等**：重复执行不会覆盖你已有的 `.env`，迁移天然可重放。

---

## 3. 分步详解（从零到上线）

### 3.1 生成 `.env`

脚本会自动生成。手动方式：

```bash
cp .env.example .env
# 编辑 .env，务必设置：
#   DB_PASSWORD   强密码（openssl rand -hex 32）
#   JWT_SECRET    强密钥（openssl rand -hex 32）
#   APP_URL       站点地址，生产填 https://你的域名
```

`.env` 中 `__AUTO_GENERATE__` 占位符会被脚本替换为强随机值。

### 3.2 启动容器

```bash
# HTTP 模式（nginx 反代，监听 80）
docker compose -f docker-compose.prod.yml --profile http up -d --build

# HTTPS 模式（Caddy 自动证书，监听 80/443）
docker compose -f docker-compose.prod.yml --profile https up -d --build
```

> 使用 `--profile` 显式选择入口：`http` 起 nginx，`https` 起 Caddy。裸 `docker compose up -d` 只会起 postgres/app/im 三个服务（无对外入口），请务必带 `--profile`（或直接用 install.sh）。

### 3.3 数据库迁移

首次部署必须执行迁移建表（install.sh 已自动执行）：

```bash
docker compose -f docker-compose.prod.yml exec -T app npx --no-install prisma migrate deploy
```

### 3.4 初始化账号

访问站点首页，通过注册页创建第一个管理员账号（注册后角色按 `seed` 脚本逻辑授予）。

> 演示数据：`prisma/seed.ts` 会创建演示账号（陈牧之 / `demo123456` 等）。该脚本依赖 `tsx`（devDependency），standalone 镜像未内置，建议在开发环境执行 `npm run db:seed` 后再导出，或临时进容器安装 `tsx`。

### 3.5 上线前检查清单

- [ ] `.env` 中 `DB_PASSWORD` / `JWT_SECRET` 已改为强随机值（非默认）
- [ ] `APP_URL` 为正式 `https://域名`（末尾不带斜杠）
- [ ] HTTPS 模式已配置 `DOMAIN` 且 DNS 已解析到本机
- [ ] 防火墙仅放行 80/443；5432 未对公网暴露（`PG_EXPOSE_PORT` 留空）
- [ ] `docker compose -f docker-compose.prod.yml ps` 各服务为 healthy/running
- [ ] 可正常登录并收发 IM 消息（验证 WebSocket 反代）

---

## 4. 环境变量表

> 下表从 `.env.example` 与 `src/`、`im-server/` 真实代码提取。标注「预留」的变量当前业务代码**未消费**，仅保留占位，不配置不影响运行。

### 4.1 数据库

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `DB_USER` | Docker 必填 | `pm` | postgres 用户；compose 用它拼接 DATABASE_URL |
| `DB_PASSWORD` | Docker 必填 | 自动生成 | postgres 密码；务必改为强密码 |
| `DB_NAME` | 否 | `pm` | 数据库名 |
| `DATABASE_URL` | 裸机必填 / Docker 可选 | 无 | Prisma 连接串（`prisma/schema.prisma`）。Docker 下留空则用 DB_* 拼内置 postgres；指向外部库时显式设置 |
| `PG_EXPOSE_PORT` | 否 | 空（仅回环 `127.0.0.1:5432`） | 对外暴露 postgres 端口；留空仅本机回环可达（公网不可见），设 `5432` 则全接口暴露 |

### 4.2 应用入口

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `APP_URL` | Docker 必填 | `http://localhost` | 站点对外地址；compose 展开到 NEXT_PUBLIC_* / NEXTAUTH_URL |
| `DOMAIN` | 仅 HTTPS | 空 | Caddy 签发证书的域名（如 `pm.example.com`） |
| `HTTP_PORT` | 否 | `80` | HTTP 模式下 nginx 监听端口 |

### 4.3 认证

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `JWT_SECRET` | 必填 | 自动生成 | 主服务与 IM 共用 JWT 密钥（HS256，30 天）。`src/lib/auth.ts` 生产环境未配置会抛错拒绝启动 |
| `JWT_REFRESH_SECRET` | 预留 | — | 当前代码未消费 |
| `NEXTAUTH_SECRET` | 预留 | — | 当前代码未消费（项目为自研 JWT，无 next-auth 依赖） |
| `NEXTAUTH_URL` | 预留 | — | `next.config.js` 有 env 映射，但无业务消费者 |

### 4.4 前端地址（NEXT_PUBLIC_*，构建期内联）

> 这些变量在 `next build` 时被固化进客户端 bundle，运行时注入无效。Docker 构建时由 compose 的 `build.args` 注入（见 `deploy/Dockerfile.app`）。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `NEXT_PUBLIC_APP_URL` | 否 | `http://localhost:3000` | 站点地址；`src/constants/index.ts`、`src/app/sitemap.ts`、`robots.ts` |
| `NEXT_PUBLIC_API_URL` | 否 | 空（同源） | API 基址；`src/services/api.ts`。留空则走同源 `/api`（推荐） |
| `NEXT_PUBLIC_WS_URL` | 否 | `http://localhost:3002` | IM WebSocket 地址，**只填 origin 根**（不要带 `/socket.io` 等路径，否则 socket.io-client 会误当 namespace）；`src/components/socket-provider.tsx`、`use-im-hooks.ts` |
| `NEXT_PUBLIC_APP_NAME` | 预留 | `项目管理系统` | 当前代码未消费 |

### 4.5 文件 / 网盘

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `FILE_ROOT` | 否 | `uploads`（`cwd/uploads`） | 文件卷根目录；Docker 下由 compose 覆盖为 `/data/pm-files`；`src/lib/file-storage.ts` |
| `FILE_MAX_SIZE` | 否 | `104857600`（100MB） | 单文件上限（字节）；`src/lib/file-storage.ts` |
| `FILE_QUOTA_PER_PROJECT` | 否 | `10737418240`（10GB） | 每项目配额（字节）；`src/lib/file-storage.ts` |
| `ALLOWED_FILE_TYPES` | 否 | 空（接受任意 MIME） | 逗号分隔的允许 MIME；`src/lib/file-storage.ts` |
| `DRIVE_RECYCLE_RETAIN_DAYS` | 否 | `30` | 回收站保留天数；`src/lib/drive.ts` |

### 4.6 AI 助手（可选，不配置则 AI 功能不可用）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AI_API_KEY` | 否 | 空 | AI API 密钥；`src/lib/ai/mimo.ts`（配了走 Bearer 模式） |
| `AI_BASE_URL` | 否 | MIMO 默认 | AI 服务地址；优先级高于旧 MIMO_* |
| `AI_MODEL` | 否 | MIMO 默认 | 模型名 |
| `MIMO_API_KEY` / `MIMO_BASE_URL` / `MIMO_MODEL` | 否 | — | 旧版兼容回退；`src/lib/ai/mimo.ts` |

### 4.7 IM 服务（均有默认值）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `IM_PORT` | 否 | `3002` | 监听端口；`im-server/src/config.js` |
| `IM_DATABASE_URL` | 否 | 回退 `DATABASE_URL` | IM 独立连接串；`im-server/src/config.js` |
| `IM_STORE` | 否 | `auto` | 存储模式 `auto`/`memory`/`prisma`；`im-server/src/store/index.js` |
| `CORS_ORIGIN` | 否 | 空 | Socket.IO 允许的来源（逗号分隔）；`im-server/src/server.js` |
| `IM_HEARTBEAT_MS` | 否 | `30000` | 心跳间隔；`config.js` |
| `IM_HEARTBEAT_TIMEOUT_MS` | 否 | `10000` | 心跳超时；`config.js` |
| `IM_NOTIFY_CHANNEL` | 否 | `im_events` | PG NOTIFY 频道；`config.js` |
| `IM_SEED_DEMO` | 否 | `true` | 注入联调演示会话（test-user-a/b/c），生产建议 `false`；`config.js` |

---

## 5. 常见问题（FAQ）

### Q1：端口被占用（80/443/5432 冲突）

```bash
# 查看占用
ss -tlnp | grep -E ':(80|443|5432)'
```

- **80/443 被占用**（如已有 nginx/apache）：改 `HTTP_PORT` 换 HTTP 端口；HTTPS 模式需先停掉占用 80/443 的进程（Caddy 需要这两个端口做证书签发与重定向）。
- **5432 被占用**（本机已装 postgres）：把 `.env` 里的 `PG_EXPOSE_PORT` 改为未占用端口（如 `5433`，映射为 `5433:5432`）；或直接注释 `docker-compose.prod.yml` 中 postgres 服务的 `ports` 段（完全仅容器网络）。

### Q2：数据库迁移报错 / 表不存在

```bash
# 查看 postgres 是否 healthy
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs postgres

# 查看迁移状态
docker compose -f docker-compose.prod.yml exec -T app npx --no-install prisma migrate status
```

- 常见原因：`DATABASE_URL` 指向错误、postgres 未 healthy、密码含特殊字符未加引号。
- 迁移是幂等的，可安全重跑 `prisma migrate deploy`。

### Q3：IM 消息发不出 / 连接断开

- 确认 `NEXT_PUBLIC_WS_URL` 为 **origin 根**（如 `https://你的域名`），不带 `/socket.io` 路径。
- 确认反代配置含 `/socket.io/` 路由与 WebSocket Upgrade 头（本仓库 `deploy/nginx.conf`、`deploy/Caddyfile` 已内置）。
- 查看 IM 日志：`docker compose -f docker-compose.prod.yml logs im`。
- 首次部署后若 im 处于 `memory` 回退模式，重启一次即可切到 prisma：`docker compose -f docker-compose.prod.yml restart im`（install.sh 已自动处理）。

### Q4：HTTPS 证书签发失败

- Caddy 要求域名 **DNS 已解析到本机**，且 80/443 端口可公网访问。
- 确认 `.env` 中 `DOMAIN` 正确；查看日志：`docker compose -f docker-compose.prod.yml --profile https logs caddy`。
- 国内服务器若 80 端口被墙，改用 HTTP 模式 + 自备证书（放入 `deploy/certs/` 并在 nginx 中启用 443 server）。

### Q5：改了 `.env` 后没生效

- 改 `.env` 后需重建并重启：`docker compose -f docker-compose.prod.yml up -d --build`。
- 注意 `NEXT_PUBLIC_*` 是**构建期**变量，改后必须 `--build` 重新构建镜像才生效。

### Q6：镜像构建失败 / 内存不足

- 构建在容器内进行，与本机 npm 无关；若服务器内存紧张，构建时关闭并行：给 docker 配置内存上限，或使用更小基础镜像。
- 国内拉取镜像慢：配置 Docker 镜像加速器（如阿里云/中科大源）。

### Q7：如何备份 / 恢复数据

```bash
# 备份数据库
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U pm -Fc pm > pm.dump

# 备份文件卷
docker run --rm -v "$(docker compose -f docker-compose.prod.yml config --format json | grep -o 'pm-app.*files' | head -1)":/data -v "$PWD":/backup alpine tar czf /backup/files.tgz -C /data .

# 恢复数据库
cat pm.dump | docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U pm -d pm --clean
```

---

## 6. 常用运维命令

```bash
# 状态 / 日志
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f          # 跟踪所有
docker compose -f docker-compose.prod.yml logs -f app      # 只看 app

# 停止 / 启动 / 重建
docker compose -f docker-compose.prod.yml down             # 停止（保留数据卷）
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml up -d --build app  # 仅重建 app

# 彻底清空（含数据库数据，慎用）
docker compose -f docker-compose.prod.yml down -v

# 进入容器
docker compose -f docker-compose.prod.yml exec app sh
```

> 编排文件说明：根目录 `docker-compose.prod.yml` 为生产精简编排（推荐）；`deploy/docker-compose.yml` 为早期版本（`deploy/README.md` 亦有说明，部分信息已过时，以本文档为准）。
