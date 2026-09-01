# 安全策略（Security Policy）

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 最新 main 分支 | ✅ 活跃支持 |
| 历史 release | ⚠️ 仅安全修复（按需） |

## 报告漏洞

若发现安全漏洞，请**不要**在公开 Issue 中披露。请通过以下方式私下报告：

- 在 GitHub 上打开一个私有安全建议（Security → Report a vulnerability）
- 或邮件联系维护者

请附上：受影响版本、复现步骤、潜在影响、建议修复。我们会在确认后尽快修复并发布安全公告。

## 已知安全考量

- 系统使用自研 JWT（HS256）鉴权，`JWT_SECRET` 必须为高强度随机值，生产环境必须通过环境变量注入
- 所有管理 API 均经 `requireAuth` / `requireRole` / `requireCan` 鉴权与权限校验
- 文件上传与下载走 ACL 权限判定（`src/lib/permission.ts`、`src/lib/file-access.ts`）
- 密码使用 bcrypt 哈希存储

## 最佳实践

- 不要把 `.env`、`auth.json`、证书/密钥提交进仓库（已加入 `.gitignore`）
- 部署使用 HTTPS（生产环境强制 TLS）
- 定期 `npm audit`
