# MCP 集成（AI 工具接入）

本项目内置 MCP（Model Context Protocol）服务端，让 Claude Code / Cursor / Codex 等 AI 客户端**直接管理项目与任务**——列出项目、创建任务、更新状态、查我的待办，无需打开网页。

## 快速接入

### 1. 获取访问 Token

MCP 端点复用系统的 JWT 鉴权。获取方式（任选）：

- **浏览器**：登录系统后，打开开发者工具 → Application → Local Storage，复制登录 token
- **命令行**（后续将提供 API Token 生成页）：

```bash
# 用演示账号登录换取 token（示例，实际路径以接口为准）
curl -X POST https://pm.hezongji.cn/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"chenmuzhi","password":"demo123456"}'
```

### 2. 配置客户端

**Claude Code**（项目根 `.mcp.json`）：

```json
{
  "mcpServers": {
    "pm": {
      "type": "http",
      "url": "https://pm.hezongji.cn/api/mcp",
      "headers": { "Authorization": "Bearer <你的 token>" }
    }
  }
}
```

**Cursor**：Settings → MCP → Add new MCP server → 选择 HTTP，填入 URL 与 Header。

**通用 JSON-RPC / 手动**：向 `POST /api/mcp` 发送 JSON-RPC 2.0 请求，`Accept` 头须同时包含 `application/json` 与 `text/event-stream`，并携带 `Authorization: Bearer <token>`。

## 可用工具（Tools）

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `list_projects` | 列出可见项目 | `search`, `status`, `limit` |
| `get_project` | 项目详情（含阶段/成员/统计） | `projectId` |
| `list_tasks` | 列出可见任务 | `projectId`, `status`, `assigneeId`, `search`, `limit` |
| `get_task` | 任务详情（含评论/修订统计） | `taskId` |
| `list_my_tasks` | 我的待办 | `limit`, `onlyPending` |
| `create_task` | 创建任务 | `projectId`, `title`, `phaseId`, `priority`, `assigneeId`, `dueDate` |
| `update_task` | 更新任务 | `taskId` + 任意可更新字段 |

## 权限模型

MCP 工具严格复用系统的数据可见性与权限规则：

- **读操作**：非管理员仅能看到自己参与项目的项目/任务（`visibleProjectFilter` / `visibleTaskFilter`）
- **写操作**：仅项目成员或管理员可 `create_task` / `update_task`，越权返回错误
- **会话隔离**：每个 MCP 会话绑定发起鉴权的用户，权限随该用户，不越权

## 协议说明

- 传输：MCP Streamable HTTP（stateful，服务端签发 `mcp-session-id`）
- 协议版本：`2025-06-18`
- 实现：官方 `@modelcontextprotocol/sdk`，代码见 `src/lib/mcp/tools.ts` 与 `src/app/api/mcp/route.ts`
