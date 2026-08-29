# 项目管理系统（Project Management System）

<div align="center">

一个面向**工程项目全生命周期管理**的现代化团队协作平台，覆盖从销售立项到结项归档的六阶段全流程，集成采购管理、费用报销、即时通讯、AI 助手与多维数据视图。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6.14-2D3748)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)](https://www.postgresql.org/)

</div>

---

## ✨ 功能特性

### 项目全生命周期
- **六阶段流程**：销售立项 → 启动与工艺设计 → 电气与机械设计 → 生产发货与现场安装 → 调试验收运维 → 结项归档
- **22 环节标准模板**：预置工程行业标准流程模板，新建项目一键实例化，实例可编辑（环节增删、调序、依赖调整）
- **依赖驱动状态机**：完成后开始 / 开始后开始两种依赖，就绪自动触发 + 通知，进度自动计算

### 任务与协作
- 任务 CRUD + 修订快照 + 批注 + 评论，支持标注与回滚
- 文件目录树 + 交付物多版本管理（上传自动提取文本）
- Excel 清单导入导出（结构化数据）

### 采购管理
- 采购申请 → 订单 → 合同 → 付款 → 到货，完整状态机
- 分批到货、追加采购、金额三级脱敏（采购部/财务部/其余）

### 费用报销
- **报销单 + 费用明细**模型，支持 11 类费用分类 + 自定义
- 审批流：提交 → 管理员审批 → 财务打款，可驳回重提
- 权限：金额仅提交人 / 财务 / 管理员可见

### 即时通讯
- Socket.IO 实时聊天，支持群聊、卡片消息、@提及
- 问题上报闭环（问题 → 会话 → 任务 → 解决）

### AI 助手
- 项目上下文问答，自动聚合全部文件提取文本
- 文件解读、数据提取、采购分解、会议纪要

### 权限与安全
- **双轴权限模型**：角色管操作（permission），可见性管数据（visibility）
- JWT 认证 + 登录限流 + SQL 注入防护 + XSS 防护 + 财务脱敏

### 体验
- 5 套主题（浅色/深色/暖阳/雾蓝/柔夜）
- 全屏窗口控制（最小化/最大化/关闭）
- 响应式设计，移动端可用

---

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | Next.js 14（App Router）+ React 18 |
| 语言 | TypeScript 5.6 |
| 样式 | Tailwind CSS + shadcn/ui + Radix UI |
| 状态管理 | Zustand + TanStack Query |
| 数据库 | PostgreSQL 16 + Prisma ORM |
| 认证 | NextAuth + JWT（jose）+ bcrypt |
| 实时通信 | Socket.IO |
| 文件处理 | xlsx / pdf-parse / mammoth / jszip |
| 拼音 | pinyin-pro（中文姓名转全拼登录账号） |

---

## 🚀 快速开始

### 环境要求

- Node.js 18+
- PostgreSQL 14+（或 16）

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/hezongji/project-management-system.git
cd project-management-system

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，填入数据库连接等配置

# 4. 初始化数据库
npx prisma migrate deploy
npm run db:seed   # 写入演示数据（含 22 环节模板、费用分类等）

# 5. 启动开发服务器
npm run dev
# 访问 http://localhost:3000
```

### 生产构建

```bash
npm run build
npm start
```

---

## 📁 项目结构

```
src/
├── app/                        # Next.js App Router 页面与 API
│   ├── (auth)/                 # 登录/注册
│   ├── (main)/                 # 主应用（工作台/项目/任务/文件/采购/视图/设置）
│   └── api/                    # API 路由（projects/tasks/files/purchase/expense-claims/im/ai...）
├── components/                 # React 组件
│   ├── ui/                     # 基础 UI（shadcn）
│   ├── layout/                 # 布局（侧边栏/顶栏/主题）
│   ├── projects/               # 项目（阶段树/阶段卡/权限矩阵）
│   ├── expense/                # 费用报销（报销单/明细/审批）
│   └── ai/                     # AI 助手
├── lib/                        # 核心逻辑
│   ├── permission.ts           # 角色操作权限
│   ├── data-visibility.ts      # 数据可见性 + 财务脱敏
│   ├── phase-engine.ts         # 阶段状态机 + 项目实例化
│   └── ...
├── services/                   # 前端 API 封装（axios）
├── store/                      # Zustand 状态
└── prisma/                     # 数据库 schema / 迁移 / 种子
```

---

---

## 📄 许可证

[MIT License](LICENSE) © 2026 hezongji

> 本项目为技术框架开源，演示数据均为虚构。
