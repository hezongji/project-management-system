# S2 架构骨架：移动端 UI/UX 彻底重适配（20260830-mobile-ui）

> 架构师：deepseek-v4-pro(high)。输入：intent.md + 代码库走查。本文供 GLM 展开为 spec.md。

## 0. 现状走查结论

- 主布局 `src/app/(main)/layout.tsx`：桌面 = `Sidebar`(lg:pl-60/16) + `Header` + `<main>`；移动端 Header 已有零散 `lg:hidden`(汉堡) / `sm:hidden`(搜索)。
- `src/app/im/page.tsx` 已有完整移动端底部 Tab 框架（`h-dvh` + `env(safe-area-inset-bottom)` + 四 Tab + 角标），是**复用的模式模板**。
- `src/components/im-mobile/` 9 组件：conversation-list（卡片列表+搜索+空态）、member-drawer（右侧滑入抽屉）、image-viewer（全屏）、upload-picker（底部弹层）——**移动组件模式已有现成范例**。
- 导航定义集中：`src/components/layout/sidebar.tsx` 的 `NAV_GROUPS`（7 组 + pageKey 权限 + adminOnly）。
- 缺：`ui/sheet.tsx`（底部抽屉）、`useIsMobile` hook、统一移动组件库。
- AI 助手悬浮球 `assistant-panel.tsx` 为 `fixed bottom-5 right-5`，与底部 Tab 冲突需处理。
- 主题体系：6 套主题 + CSS 变量 `--background/--primary/--gradient-from/--sidebar/--chat-bg/--glow-a` 等，移动端必须全程用变量不硬编码。

## 1. 组件体系设计（新增 src/components/mobile/）

与 im-mobile 的关系：im-mobile 是 IM 业务专用组件树（不修改）；mobile/ 是**通用移动组件库**，供 (main) 下 12 页面复用。两者独立，模式一致（微信式卡片列表/底部抽屉/安全区）。

| 组件 | 职责 | 关键 props |
|---|---|---|
| `MobileTabBar` | 底部 4 Tab 导航栏，复用 im 页 Tab 样式 | `items: {key,label,icon,to,badge?}[]`, `activeKey`, `onNavigate`；内建 `env(safe-area-inset-bottom)` padding + `border-t bg-card` |
| `MobilePageHeader` | 移动端页头（标题 + 可选返回 + 右侧动作） | `title`, `onBack?`, `right?`, `sticky?`；高度 ≥44px，`px-4` |
| `MobileList` / `MobileListItem` | 卡片化列表 + 行项（替代表格行） | `items[]`, `renderItem`, `onItemClick`；行项触控高度 ≥44px，`active:bg-muted/60` |
| `MobileCard` | 移动端信息卡（统计/概览/详情块） | 复用现有 `ui/card` 语义，提供 `p-4` 默认 + 图标槽 |
| `MobileSheet` | 底部抽屉（通用，替代 Dialog/Select 下拉在移动端） | 新增 `src/components/ui/sheet.tsx`（或 mobile/sheet.tsx），`open`, `onClose`, `title`, `children`；底部滑入 `rounded-t-2xl` + 遮罩 |
| `MobileEmptyState` | 空态占位（图标+文案+可选动作） | `icon`, `title`, `desc?`, `action?` |
| `MobileSearchBar` | 移动端搜索输入（复用 conversation-list 的搜索框样式） | `value`, `onChange`, `placeholder` |
| `MobileStatusChip` | 状态徽章（采购状态/任务状态/项目状态统一移动展示） | `status`, `meta`（映射色） |
| `MobileFab` | 浮动操作按钮（新建项目/新建任务等） | `icon`, `onClick`, `label`；`fixed bottom-20 right-4`（避开 Tab 栏） |
| `MobileSegmentedTabs` | 移动端分段 Tab（替代 desktop Tabs，横向滚动或均分） | `tabs[]`, `active`, `onChange` |

**复用现有 UI**：`ui/button`(btn-gradient)、`ui/badge`、`ui/card`、`ui/dialog`(桌面继续用)。移动端 Dialog 弹层统一走 MobileSheet。

## 2. 布局接入方案

### 2.1 双形态主布局（src/app/(main)/layout.tsx）

```
<div min-h-screen>
  <Sidebar />                 ← 桌面 lg: 显示（现状不动）
  <div flex-col lg:pl-60/16>  ← 桌面侧边栏留白；移动端 lg:pl-0
    <Header />                 ← 桌面完整顶栏；移动端简化（见 2.3）
    <main flex-1 pb-16 lg:pb-6>  ← ★ 移动端加 pb-16 给底部 Tab 让位
      {children}
    </main>
    <MobileTabBar />           ← ★ 移动端(lg:hidden)显示；桌面隐藏
  </div>
  <AssistantPanel />           ← 移动端 FAB 上移避开 Tab（见 2.4）
</div>
```

- 断点：统一用 `lg`(1024px) 作为桌面/移动分界。现有 `md:`/`sm:` 零散断点逐步统一到 `lg`。
- `MobileTabBar` 仅 `lg:hidden`，桌面 `hidden`。桌面侧边栏保持 `lg:` 控制。

### 2.2 底部 Tab 导航路由映射（4 Tab）

| Tab | 图标 | 路由 | 说明 |
|---|---|---|---|
| 首页 | LayoutDashboard | `/` | 工作台 |
| 项目 | FolderKanban | `/projects` | 项目列表 |
| 待办 | CheckSquare | `/todos` | 待办（含催办） |
| 我的 | UserRound | 打开抽屉 | 不跳路由，展开"更多"抽屉 |

**"我的"抽屉内容**（复用 NAV_GROUPS 剩余入口 + 账号）：
- 消息 /messages、任务 /tasks、采购 /purchase、文件 /files
- 管理组（adminOnly）：组织 /organization、系统管理 /settings
- 流程模板、统计图表、帮助 /help
- 主题切换 + 退出登录（从桌面侧边栏底部迁入）
- 实现：`MobileSheet` 底部抽屉，列表项复用 NAV_GROUPS 数据 + 权限过滤（isAdmin/pages 逻辑与侧边栏一致）。

**子路由策略**：详情页（`/projects/[id]`、`/projects/[id]/phases/[phaseId]`、`/tasks`、采购详情、文件详情等）进入二级视图时，底部 Tab 栏**仍保留但切换为"返回键"形态**或直接隐藏。架构建议：**Tab 栏常驻，二级页用 MobilePageHeader 的返回箭头**（微信式：Tab 始终在底部，页面内返回）。特殊：`/im` 已有自己的 Tab，主布局在 `/im` 路由**不渲染 MobileTabBar**（避免双 Tab）——用 `usePathname()` 判断，`pathname.startsWith('/im')` 时隐藏主 Tab 栏，且 main 不加 pb-16。

### 2.3 移动端 Header 简化

移动端 Header（lg:hidden）收敛为：`汉堡(打开全屏菜单抽屉) + 页面标题/Logo + 通知铃 + 头像`。搜索收进独立 MobileSearchBar（点搜索图标展开）。保留现有 `setMobileMenuOpen` 汉堡（其抽屉改为复用 MobileSheet 模式）。桌面 Header 现状不动。

### 2.4 AI 助手悬浮球冲突

`assistant-panel.tsx` FAB `fixed bottom-5 right-5` 在移动端会压住底部 Tab 栏 → 移动端改 `bottom-20`（Tab 栏之上），面板高度 `h-[520px]` 移动端改 `max-h-[60dvh]`。桌面不变。

## 3. 页面改造模式（12 页）

通用转换规则：
- **表格 → MobileList 卡片**：每行变卡片（主信息 + 副信息 + 状态徽章 + 右箭头），点击进详情。
- **弹窗/下拉 → MobileSheet 底部抽屉**：筛选、操作、表单在移动端用底部抽屉。
- **桌面 Tabs → MobileSegmentedTabs**：横向均分或横向滚动分段。
- **分页 → 触底加载**：移动端 MobileList 支持 `onLoadMore`（无限滚动），桌面保留 TablePagination。
- **双栏 → 主从切换**：文件页左树右列表、项目详情 tab，移动端改为"列表 → 点进详情"两级。

| 页面 | 移动端策略 | 关键转换 |
|---|---|---|
| 工作台 `/` | 统计卡改横滑 carousel（4 卡横向滚动）或 2×2 网格；待办/最近项目/最近活动改卡片流 | 桌面 grid → 移动 2 列小卡 + 卡片流 |
| 项目列表 `/projects` | 已是卡片 grid，移动端改单列卡片流 + FAB 新建 | grid-cols-4 → 1 列，触控高度 |
| 项目详情 `/projects/[id]` | 概览 dl 改竖排卡片；阶段/任务子 tab 用 SegmentedTabs；底部 Tab 保留 + 页头返回 | dl 3 列 → 竖排；操作按钮 → 底部固定操作条 |
| 阶段/任务详情 | 二级页，页头返回 + 内容卡片化 | 表格 → 卡片流 |
| 任务 `/tasks` | 表格 → 卡片流（任务名+负责人+状态+截止），筛选 → MobileSheet | TablePagination → 无限滚动 |
| 待办 `/todos` | 待办/催办 Tabs → SegmentedTabs；列表 → 卡片；处理动作 → 底部 Sheet | Card+Table → MobileList |
| 采购 `/purchase` | 九状态卡 → 横滑状态 chips；订单表 → 卡片流；审批操作 → 底部 Sheet 保留完整流程 | 状态组卡 → 横滑 chips；表格 → 卡片 |
| 文件 `/files` | 双 Tab(交付计划/网盘) → SegmentedTabs；左树右列表 → "目录列表 → 点进看条目"两级；上传 → 底部 Sheet | 双栏 → 主从；树 → 折叠列表 |
| 组织 `/organization` | 树 → 可折叠列表（DeptTreeItem 移动端收缩层级）；结构图 → 缩放/列表切换 | 树 → 列表视图优先 |
| 设置 `/settings` | 已较多 sm: 断点，统一到 lg；表单 → 卡片分组 + 底部 Sheet | 微调 + 触控目标 |
| 帮助 `/help` | 已有适配，统一断点 | 微调 |

## 4. 风险与冲突清单

1. **主题兼容**：所有新组件一律 `bg-card/text-foreground/border-border/hsl(var(--*))`，禁用硬编码色值；底部 Tab 用 `bg-card`（与 im 页一致）；渐变按钮沿用 `btn-gradient`。六主题 + 渐变变量无需改动。
2. **/im 双 Tab 冲突**（高风险）：主布局 MobileTabBar 在 `/im` 必须隐藏，否则 IM 页四 Tab + 主布局四 Tab 叠两层。用 `usePathname().startsWith('/im')` 守卫，同时 main 的 `pb-16` 在 /im 不加。**这是 S3 第一个要写测试的点**。
3. **messages 桌面页 vs /im**：移动端访问 `/messages`（桌面 IM 页）应重定向 `/im` 或显示 `/im` 内容（im 页已 PageGuard messages 权限）。避免两套 IM 并存。
4. **AI 助手 FAB 遮挡**：见 2.4，移动端上移。验证点：375px 下 FAB 不与 Tab 重叠。
5. **现有 md:/sm: 断点冲突**：12 页现存零散断点，与统一 lg 断点可能打架。改造时逐页清理，验收用 375px 走查兜底。
6. **安全区**：底部 Tab 用 `env(safe-area-inset-bottom)`；页头用 `env(safe-area-inset-top)`（viewport-fit:cover 已开）。iPhone 刘海/手势条验证。
7. **触控目标 ≥44px**：列表行、按钮、Tab 均保证 min-h-11（44px）；小按钮移动端放大。
8. **键盘遮挡**：表单页（采购审批、新建项目）输入框在移动端用 `pb-[env(safe-area-inset-bottom)]` + `scrollIntoView`；聊天输入已有处理。
9. **桌面零回归**：所有移动改动包裹在 `lg:hidden`（仅移动显示）或 `lg:` 前缀内，桌面路径（≥1024px）完全不变。verify.mjs + 桌面截图走查兜底。
10. **无 sheet 组件**：需新增 `ui/sheet.tsx`（基于 radix 或自绘，沿用现有 dialog 模式，底部滑入）。不引新依赖，自绘即可（项目已有自绘 drawer 先例 member-drawer）。
11. **App WebView**：主布局改造后，WebView 内打开非 /im 页面（如从 IM 跳转任务卡片）也会走移动布局 + 底部 Tab——符合预期；但 /im 内跳转出的详情页返回栈需正确（im 页已有 pm-back 事件桥，主布局详情页需兼容返回）。
12. **验收脚本 mobile-ui-verify.mjs 建议**：用 playwright 375px 遍历核心链路，断言：①`document.documentElement.scrollWidth <= 375`（无横向滚动）②关键元素 visible ③所有可交互元素 `offsetHeight >= 44 || width>=44`（触控）④底部 Tab 存在且 4 项 ⑤`/im` 下无重复 Tab。桌面 1280px 断言侧边栏在、Tab 栏不在（无回归）。
