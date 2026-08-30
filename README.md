# PM 项目管理系统 + 企业即时通讯（IM）

一套面向工程项目型企业的管理系统：项目全生命周期管理（阶段/任务/文件/采购/费用）+ 内置企业微信式即时通讯，含独立的 Android 聊天 App。

## 功能概览

### 项目管理系统（Web）
- 项目管理：项目台账、阶段、任务、交付物
- 采购管理：采购申请、供应商、订单、到货
- 费用管理：报销单
- 组织架构、权限分配、帮助中心、质检驾驶舱

### 文件管理（项目网盘）
- 目录树：一棵树融合制——阶段/系统目录（受保护）与用户自建目录并存；物理路径解耦，移动文件仅改 `folderId`，零文件搬迁
- 网盘视图：左树右列表、面包屑导航、拖拽移动、多文件上传、批量下载（zip 流式打包）
- 版本管理：同名文件自动版本合并、版本徽章、版本历史浏览
- 回收站：软删 + 30 天保留期，可恢复 / 彻底删除，定时任务自动清理
- 全局搜索：跨项目文件名检索
- 权限：项目成员 / 管理者 / 所有者分级 ACL，目录权限沿祖先链并集判定

### 即时通讯（IM）
- 网页端 `/messages` + 独立 Android App「PM 聊天」（WebView 壳）
- 会话：单聊 / 群聊 / 项目群（成员自动=项目成员）
- 消息：文字、图片、文件、语音、@提及、@所有人、引用回复、撤回、多选转发删除
- 通讯录：公司组织架构（部门树）+ 项目通讯录，点人直接开聊、多选建群
- 附件自动归档：项目群附件自动入项目文件夹，普通聊天附件入「聊天记录」共享文件夹
- 群公告、消息免打扰、会话置顶/删除、未读聚合

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js 16 (App Router) + React + TypeScript + Tailwind CSS + TanStack Query |
| IM 后端 | Node.js + Socket.IO（独立进程 `im-server`） |
| 数据库 | PostgreSQL + Prisma |
| Android App | Kotlin WebView 壳（`mobile-app/`），原生 MediaRecorder 录音桥 |

## 架构

```
┌─ PM 网页 (Next.js :3001) ── 项目管理 / IM 页面 / REST API
│        │ 共享 PostgreSQL（User/Conversation/Message/File...）
│        │ 共享 JWT_SECRET
├─ im-server (Socket.IO :3002) ── 实时消息推送
└─ mobile-app (Android WebView 壳) ── 加载 /im，原生录音 JS 桥
```

关键设计：IM 与 PM 系统**共享同一数据库与 JWT 体系**，App 与网页消息天然同步，无需额外同步机制。

## 快速开始

```bash
# 1. 安装依赖
npm install
cd im-server && npm install && cd ..

# 2. 配置环境变量（复制示例，填入真实值）
cp .env.example .env
cp im-server/.env.example im-server/.env

# 3. 初始化数据库
npx prisma migrate deploy
npx prisma db seed

# 4. 启动
npm run dev            # PM 主服务（:3000）
cd im-server && node src/index.js   # IM 服务（:3002）
```

> ⚠️ `.env` 文件含敏感配置（数据库密码、JWT_SECRET、AI key），已加入 `.gitignore`，切勿提交。

## Android App 打包

```bash
# 需 JDK 17 + Android SDK (compileSdk 34)
bash scripts/build-apk.sh   # 产出 mobile-app/app/build/outputs/apk/release/pm-chat-<version>.apk
```

首次运行会生成自签 keystore（`mobile-app/keystore/`，已 gitignore），**请务必异地备份**——丢失会导致已装用户必须卸载重装。

## 部署

参考 `deploy/`（Docker Compose 全栈编排）与 `k8s/`（Kubernetes 示例）。生产环境务必：
- 替换所有 `.env` / `k8s/secrets.yaml` 占位符为真实强随机值
- nginx 配置 APK 分发目录与 Socket.IO WebSocket 升级（见 `deploy/nginx.conf`）

## 目录结构

```
src/            PM 主服务（Next.js 页面 + API + IM 前端组件）
im-server/      独立 IM 实时服务（Socket.IO）
mobile-app/     Android WebView 壳（原生录音桥）
prisma/         数据库 schema 与迁移
scripts/        打包 / QA 回归 / 验证脚本
deploy/         Docker 部署
k8s/            Kubernetes 示例
```

## 许可证

[MIT](./LICENSE)
