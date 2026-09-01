# 贡献指南

感谢考虑为本项目做贡献！本项目是面向工程项目型企业的开源管理系统（项目管理 + 采购 + 费用 + 文件网盘 + 企业 IM + Android App）。

## 快速上手

```bash
# 1. 克隆并安装依赖
git clone https://github.com/hezongji/project-management-system.git
cd project-management-system
npm install
cd im-server && npm install && cd ..

# 2. 配置环境变量
cp .env.example .env          # 填入 DATABASE_URL、JWT_SECRET 等

# 3. 初始化数据库
npm run db:generate
npm run db:push
npm run db:seed               # 种子数据（可选 db:seed-demo 演示数据）

# 4. 启动
npm run dev                   # Web :3001
cd im-server && npm run dev   # IM :3002（如需要）
```

## 开发规范

- 后端 API 遵循统一响应壳（`src/lib/api-helpers.ts`）：`apiHandler` + `requireAuth` + `ok`/`fail`
- 前端组件放 `src/components/`，页面放 `src/app/`
- 新数据模型先改 `prisma/schema.prisma`，再 `npm run db:generate`
- TypeScript 严格模式，提交前跑：

```bash
npm run lint
npm run type-check
npm run format:check
```

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <中文 subject>

[body]
[footer]
```

- type：feat / fix / docs / refactor / perf / test / chore / style
- scope：可选，如 `drive`、`im`、`purchase`、`mcp`、`mobile`

## 提交 PR

1. Fork 本仓库，基于 `main` 建特性分支
2. 完成后提交 PR，描述清楚改动与动机
3. 小修复直接提；大功能建议先开 Issue/Discussion 讨论

## 报告问题

- Bug：开 Issue，附复现步骤、环境（Node 版本、浏览器）、截图
- 功能建议：开 Discussion（Ideas）
- 安全漏洞：见 [SECURITY.md](./SECURITY.md)

## 行为准则

请遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
