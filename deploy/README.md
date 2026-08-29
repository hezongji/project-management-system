# 项目管理系统 · Docker 部署

全栈容器化编排（`app + im + postgres + nginx`），一条命令启动。

## 架构

```
nginx (80 / 443)
 ├── /            → app  :3000  (Next.js 页面 + REST API)
 ├── /api/        → app  :3000  (Next.js Route Handlers)
 ├── /socket.io/  → im   :3002  (Socket.IO WebSocket, Upgrade 头)
 └── 文件卷 files → /data/pm-files
        PostgreSQL 16 (postgres, 数据卷 pgdata)
```

- **app**：Next.js 主服务，`deploy/Dockerfile.app` 多阶段构建，产出 standalone 产物
- **im**：Socket.IO 独立进程，`deploy/Dockerfile.im`
- **postgres**：PostgreSQL 16，数据卷 + 健康检查，`app`/`im` 均 `depends_on` 且等待 healthy
- **nginx**：反向代理 + WebSocket 升级 + gzip + 安全头

## 前置要求

- Docker ≥ 24（含 Docker Compose v2）
- `next.config.js` 已启用 `output: 'standalone'`（本仓库已配置）
- 主服务 `package.json` 的 `build` 脚本为 `next build`
- `im-server/` 目录已就绪（含 `package.json`、`index.js`、共享 `prisma/`），并被 `Dockerfile.im` 引用

> ⚠️ 注意：Prisma `schema.prisma` 的 `datasource db` 当前为 `sqlite`。部署到 PG 前需改为 `provider = "postgresql"` 并把 `DATABASE_URL` 指到本 compose 的 `postgres` 服务。

## 一键启动

```bash
cd project-management-system

# 1. 准备环境变量
cp deploy/.env.example .env
# 编辑 .env，务必更换 DB_PASSWORD / JWT_SECRET / NEXTAUTH_SECRET

# 2. 启动全栈
docker compose -f deploy/docker-compose.yml up -d

# 3. 查看状态
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f
```

## 首次初始化

数据库表结构由 Prisma migration 管理，首次启动后执行迁移：

```bash
docker compose -f deploy/docker-compose.yml exec app npx prisma migrate deploy
```

## 访问

| 入口 | 说明 |
|------|------|
| `http://<host>/` | 主服务（跳转 /dashboard） |
| `http://<host>/api/...` | REST API |
| `ws://<host>/socket.io/` | IM WebSocket |

## 常用操作

```bash
# 停止
docker compose -f deploy/docker-compose.yml down

# 停止并清数据（含 PG 数据卷，慎用）
docker compose -f deploy/docker-compose.yml down -v

# 重新构建镜像
docker compose -f deploy/docker-compose.yml build --no-cache

# 仅重建 app（代码变更后）
docker compose -f deploy/docker-compose.yml up -d --build app

# 查看 PG 日志 / 健康状态
docker compose -f deploy/docker-compose.yml logs -f postgres
```

## 语法校验

```bash
docker compose -f deploy/docker-compose.yml config -q && echo "compose 校验通过"
```

## HTTPS 启用（生产）

1. 将证书 `fullchain.pem` + `privkey.pem` 放入 `deploy/certs/`
2. 编辑 `deploy/nginx.conf`：取消 80→443 重定向注释，新增 443 `server` 块（参考 80 段写法）
3. 更新 `.env` 的 `APP_URL=https://你的域名`
4. `docker compose -f deploy/docker-compose.yml up -d nginx`

## 备份（建议）

- PG：`docker compose -f deploy/docker-compose.yml exec postgres pg_dump -U pm -Fc pm > pm.dump`
- 文件：备份 compose 卷 `files`（`docker run --rm -v pm_files:/data -v $PWD:/backup alpine tar czf /backup/files.tgz -C /data .`）
