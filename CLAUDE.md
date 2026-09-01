# CLAUDE.md — Claude Code 配置

> 完整仓库指引见 [AGENTS.md](./AGENTS.md)。本文只保留 Claude Code 高频所需。

## 项目

工程项目型企业开源管理系统（项目全生命周期 + 采购 + 费用 + 文件网盘 + 企业 IM + Android App）。
Next.js 16 (App Router) + TypeScript + Prisma + Socket.IO。

## 规则

- 改动前先读相关文件；不新建多余文档/文件
- 遵循统一 API 响应壳（`src/lib/api-helpers.ts`：`apiHandler` / `requireAuth` / `ok` / `fail`）
- 提交走 Conventional Commits，提交前跑 `npm run lint && npm run type-check`
- 不提交密钥、`.env`、证书

## 常用命令

```bash
npm run dev            # :3001
npm run build          # standalone
npm run lint && npm run type-check
npm run db:generate    # 改 schema 后
```

## 关键坑（详见 AGENTS.md）

- CJS 库（archiver）→ `serverExternalPackages` 或 `createRequire`
- `NEXT_PUBLIC_WS_URL` 只能写 origin 根域名
- 杀生产 next-server 用 `ss -tlnp` 按端口取 pid，勿用 pkill
- 任务修订走 `task-service.ts`，字段白名单 + 空修订拒绝
