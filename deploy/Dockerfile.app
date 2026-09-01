# =========================================================================
# Dockerfile.app — 项目管理系统主服务（Next.js App Router, standalone 产物）
# 多阶段构建：deps(依赖) → build(构建) → runner(运行)
# 基础镜像：node:20-alpine
# =========================================================================

# ---------- 阶段 1：deps（只装依赖，缓存层） ----------
FROM node:20-alpine AS deps
WORKDIR /app

# 安装原生依赖所需的编译工具（bcrypt 等需 node-gyp）
RUN apk add --no-cache libc6-compat python3 make g++ git

# 只复制锁文件与清单，充分利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY prisma ./prisma

# 安装全部依赖（含 devDependencies，供 build 阶段使用；postinstall 会 prisma generate）
RUN npm ci

# ---------- 阶段 2：build（生成 Prisma Client + 编译 Next standalone） ----------
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++ git

# 复用 deps 阶段安装好的 node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .

# NEXT_PUBLIC_* 为构建期内联变量（会被固化进客户端 bundle），
# 通过 compose 的 build.args 注入站点 origin，避免客户端回退 localhost
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME

ENV NEXT_TELEMETRY_DISABLED=1

# 生成 Prisma Client 并构建 standalone 产物
RUN npx prisma generate \
  && npm run build

# ---------- 阶段 3：runner（仅运行产物，精简体积） ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 运行时工具（健康检查 / 进程信号转发）
RUN apk add --no-cache dumb-init curl

# 创建非 root 运行用户
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

# 复制 standalone 产物（内含 server.js 与 .next/standalone）
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
# 静态资源 + 公共资源
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Prisma schema + 迁移脚本（供 migrate deploy 使用）
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
# 生成好的 Prisma Client 运行时依赖（standalone 已内联大部分，此处兜底）
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
# Prisma CLI（供首次部署在容器内执行 `npx prisma migrate deploy`，含 engines）
COPY --from=build --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.bin ./node_modules/.bin

# 文件卷挂载点
RUN mkdir -p /data/pm-files && chown -R nextjs:nodejs /data

USER nextjs

EXPOSE 3000

# 健康检查（根路径任意 HTTP 响应即视为存活；本项目无 /api/health 路由）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -s -o /dev/null http://localhost:3000/ || exit 1

CMD ["dumb-init", "node", "server.js"]
