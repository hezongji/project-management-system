# AGENTS.md — AI 编码代理仓库指引

面向在本仓库内工作的 AI 编码代理（Claude Code / Cursor / Codex / Pi 等）。
人类贡献者请看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 项目是什么

面向**工程项目型企业**的开源管理系统：项目全生命周期（阶段 / 任务 / 文件 / 采购 / 费用）+ 企业即时通讯（IM）+ 独立 Android App。

- 仓库：https://github.com/hezongji/project-management-system
- 在线体验：https://pm.hezongji.cn（演示账号 `chenmuzhi` / `demo123456`）

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js 16 (App Router) + React 18 + TypeScript + Tailwind CSS + TanStack Query |
| IM 后端 | Node.js + Socket.IO（独立进程 `im-server/`） |
| 数据库 | PostgreSQL + Prisma |
| Android App | Kotlin WebView 壳（`mobile-app/`、`pm-app-android/`） |
| 鉴权 | 自研 JWT（HS256），见 `src/lib/auth.ts` |

## 目录结构

```
src/
  app/          App Router（页面 + src/app/api/* 的 REST 路由）
  components/   UI 组件
  lib/          核心逻辑（auth / api-helpers / permission / task-service / phase-engine / drive ...）
  services/     服务层
  store/        Zustand 状态
  types/ utils/ config/ constants/ hooks/ locales/
im-server/      独立 Socket.IO 实时消息进程
mobile-app/     Android App（Kotlin WebView 壳）
prisma/         schema + seed
scripts/        验证 / 构建 / 迁移脚本
```

## 常用命令

```bash
npm run dev            # 开发服务器（Next.js :3001）
npm run build          # 生产构建（output: standalone）
npm run lint           # ESLint
npm run type-check     # tsc --noEmit
npm run format:check   # Prettier 检查
npm run db:generate    # Prisma client 生成
npm run db:push        # schema 同步（开发）
npm run db:migrate     # 迁移
```

## 后端 API 约定（必须遵守）

统一响应壳（`src/lib/api-helpers.ts`）：
- 成功：`{ success: true, data, message: 'ok' }`
- 失败：`{ success: false, message, error: { code, message }, errors? }`（HTTP 4xx/5xx）
- 分页：`?page=&limit=`，响应 `data: { items, pagination: { page, limit, total, pages } }`

路由写法：用 `apiHandler` 包装 handler，内部 `throw new ApiError(...)`，统一捕获输出。
- `requireAuth(request)` → 校验 Bearer Token，失败抛 401
- `requireRole(user, ...roles)` → 角色校验
- `requireCan(...)`（`src/lib/permission.ts`）→ 细粒度权限
- `visibleTaskFilter(userId, role)`（`src/lib/data-visibility.ts`）→ 数据可见性过滤（非 ADMIN 仅见所属项目）

## 鉴权

- JWT HS256，30 天过期，密钥环境变量 `JWT_SECRET`
- `getAuthUser(request)` 从 `Authorization: Bearer <token>` 提取并验证
- 前端通过 `NEXTAUTH_URL` / `NEXTAUTH_SECRET` 配 NextAuth，与 IM 共享同一 JWT 体系

## 关键坑（动手前必读）

1. **CJS 库在 Next.js 生产代码里会被 webpack 改写**：require CJS 库（如 `archiver`）会变成命名空间对象导致 `is not a function`。必须用 `createRequire(import.meta.url)`，或在 `next.config.js` 的 `serverExternalPackages` 里声明（`archiver@7` 已锁定，v8 是纯 ESM）。
2. **`NEXT_PUBLIC_WS_URL` 只能写 origin 根域名**（如 `https://pm.hezongji.cn`），带路径名会被 socket.io-client 当 namespace，报 `Invalid namespace` 断连。
3. **生产 next-server 进程名与 `next start -p <port>` 不匹配**：`pkill` 杀不掉旧进程导致新构建不生效，必须 `ss -tlnp` 按端口取 pid 强杀。
4. **任务修订走 `task-service.ts` 的修订引擎**：可修订字段白名单 `REVISABLE_FIELDS = title/description/status/priority/assigneeId/dueDate`，patch 无实际变更会被拒绝（空修订）；回滚 = 生成新修订。
5. **任务必挂阶段**：`phaseId` 可为空（历史任务），但新任务应挂阶段；阶段下建任务走 `POST /phases/:id/tasks`。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
`<type>(<scope>): <中文 subject>`，type ∈ feat/fix/docs/refactor/perf/test/chore/style。
提交前跑 `npm run lint && npm run type-check`。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
