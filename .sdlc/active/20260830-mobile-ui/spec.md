# S2 spec.md：PM 移动端 UI/UX 彻底重适配（20260830-mobile-ui）

> 展开自 architecture.md（v4-pro 骨架）+ intent.md。本文是 S3 Build 的直接依据，精确到组件签名/文件路径/接入点。
> 铁律：桌面端零改动（≥1024px DOM 与现状一致）、主题全走 CSS 变量（禁硬编码色）、不引入新依赖、不动 im-mobile/。

## 0. 全局约定

- **断点**：移动/桌面分界统一 lg(1024px)。useIsMobile() = window.matchMedia('(max-width: 1023px)')。
- **双形态实现策略**（二选一，每页按复杂度选）：
  - A. CSS 分支（简单差异）：lg:hidden（仅移动）/ hidden lg:flex（仅桌面）双写。
  - B. JS 分支（表格→卡片等结构性差异）：const isMobile = useIsMobile()，桌面返回原 JSX 不动，移动返回新 Mobile 子树。hook 初始值 false + useEffect 内 set（SSR 渲染桌面态，避免 hydration mismatch；移动端首帧后切换）。
- **触控**：可点击元素 min-h-11(44px)；图标按钮 h-11 w-11（原 h-9 桌面保留）。
- **安全区**：底部 Tab/Sheet 用 paddingBottom: env(safe-area-inset-bottom)；页头 paddingTop: env(safe-area-inset-top)（viewport-fit=cover 已在 layout viewport 导出）。
- **配色**：一律 bg-card / bg-background / text-foreground / text-muted-foreground / border-border / bg-muted / text-primary / btn-gradient。
- **文件布局**：新增 src/components/mobile/（通用库）+ src/components/ui/sheet.tsx + src/hooks/use-is-mobile.ts；页面改造在 src/app/(main)/** 原文件内。

## 1. 基础设施（S3-W1，先建后用）

### 1.1 src/hooks/use-is-mobile.ts

```ts
'use client'
import { useEffect, useState } from 'react'
/** 移动端判定（<1024px）。SSR 首帧 false（桌面态），挂载后修正，避免水合不匹配。 */
export function useIsMobile(breakpoint = 1024): boolean {
  const [m, setM] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [breakpoint])
  return m
}
```

### 1.2 src/components/ui/sheet.tsx（自绘底部抽屉，参照 dialog.tsx 遮罩 + im-mobile/member-drawer 滑入）

```tsx
'use client'
export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode          // 顶部标题条（可空）
  children: React.ReactNode
  footer?: React.ReactNode         // 底部固定操作条（按钮组）
  maxHeight?: string               // 默认 '75dvh'
}
export function Sheet({ open, onClose, title, children, footer, maxHeight }: SheetProps)
```
- 遮罩：fixed inset-0 z-50 bg-black/50（同 dialog.tsx overlay），onClick=onClose。
- 面板：fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t bg-card text-card-foreground shadow-xl，style maxHeight + paddingBottom env(safe-area-inset-bottom)，进场 translate-y-full 到 0（CSS transition，沿用 member-drawer 手法）。
- 标题条：flex h-12 items-center justify-between px-4 border-b + 右侧 ChevronDown 关闭按钮（h-11 w-11）。
- 内容区：overflow-y-auto overscroll-contain px-4 py-3。
- 关闭：Escape 键 + 遮罩点击（useEffect keydown）。
- 命名 Sheet 放 ui/ 全局复用；mobile/ 不重复做，index.ts 里 re-export { Sheet as MobileSheet }。

### 1.3 src/components/mobile/ 组件库（10 件）

**tab-bar.tsx**（复刻 im/page.tsx 底部 nav 样式）：
```tsx
import type { LucideIcon } from 'lucide-react'
export interface MobileTabBarItem {
  key: string; label: string; icon: LucideIcon
  href?: string                 // 无 href = 本地动作（如"我的"开抽屉）
  badge?: number                // >0 红点角标（99+ 截断）
}
export function MobileTabBar({ items, activeKey, onAction }: {
  items: MobileTabBarItem[]; activeKey: string; onAction?: (key: string) => void
})
```
- 外层 nav：lg:hidden fixed inset-x-0 bottom-0 z-40 flex border-t bg-card，加 data-mobile-tabbar 属性（验收打点），style paddingBottom env(safe-area-inset-bottom)。
- 项：flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px]，激活 text-primary 否则 text-muted-foreground，icon h-6 w-6（激活加 fill-primary/10）；角标 absolute -right-2.5 -top-1 h-4 min-w-[16px] rounded-full bg-red-500 text-white。
- 有 href 用 next/link；无 href 调 onAction(key)。

**page-header.tsx**：
```tsx
export function MobilePageHeader({ title, onBack, right, sticky = true }: {
  title: React.ReactNode; onBack?: () => void; right?: React.ReactNode; sticky?: boolean
})
```
- flex h-12 min-h-11 items-center gap-2 border-b bg-card px-3 + sticky top-0 z-30 + paddingTop env(safe-area-inset-top)。
- 返回 ChevronLeft 按钮 h-11 w-11 -ml-2，加 data-mobile-back 属性（验收打点）；无 onBack 不渲染；右侧动作槽按钮统一 h-11。
- 用途：二级页/详情页页头（全局 Header 保留在一级页，二者不同层）。

**list.tsx**（卡片流核心，模式取自 conversation-list 行布局）：
```tsx
export function MobileList<T>({ items, renderItem, keyOf, loading, empty }: {
  items: T[]; renderItem: (item: T, index: number) => React.ReactNode
  keyOf: (item: T) => string
  loading?: boolean; empty?: React.ReactNode
})
export function MobileListItem({ avatar, title, subtitle, status, right, onClick, danger }: {
  avatar?: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode
  status?: React.ReactNode        // MobileStatusChip
  right?: React.ReactNode         // 右箭头/金额/时间
  onClick?: () => void; danger?: boolean
})
```
- MobileListItem：button 元素 w-full text-left flex items-center gap-3 px-4 py-3 min-h-14 active:bg-muted/60。
- 容器：divide-y bg-card rounded-lg border；列表外层 space-y-3 px-3。
- loading：3 个 Skeleton 行（ui/skeleton，h-14）。

**status-chip.tsx**：
```tsx
export function MobileStatusChip({ label, tone }: { label: string; tone: 'default'|'primary'|'success'|'warning'|'danger'|'info' })
```
- tone 到类映射（全变量色）：default=bg-muted text-muted-foreground；primary=bg-primary/10 text-primary；success=bg-emerald-500/10 text-emerald-600 dark:text-emerald-300；warning=bg-amber-500/10 text-amber-700 dark:text-amber-300；danger=bg-destructive/10 text-destructive；info=bg-blue-500/10 text-blue-700 dark:text-blue-300。rounded-md px-2 py-0.5 text-xs whitespace-nowrap。
- 业务状态到 tone 映射表放各页面文件内（如采购九状态），chip 只管展示。

**empty-state.tsx**：
```tsx
export function MobileEmptyState({ icon: Icon, title, desc, action }: {
  icon: LucideIcon; title: string; desc?: string; action?: React.ReactNode
})
```
- flex flex-col items-center justify-center gap-2 py-16 px-8 text-center；icon h-10 w-10 text-muted-foreground/50；action 槽主按钮用 btn-gradient。

**search-bar.tsx**（取 conversation-list 搜索框样式）：
```tsx
export function MobileSearchBar({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
})
```
- flex h-11 items-center gap-2 rounded-lg bg-muted px-3 + Search icon + input flex-1 bg-transparent text-[15px] outline-none。

**fab.tsx**：
```tsx
export function MobileFab({ icon: Icon, label, onClick }: { icon: LucideIcon; label?: string; onClick: () => void })
```
- lg:hidden fixed bottom-20 right-4 z-40 flex h-12 items-center gap-2 rounded-full btn-gradient text-primary-foreground shadow-lg；有 label px-4 带字，无 label h-12 w-12 p-0；bottom-20 避开 Tab 栏。

**segmented-tabs.tsx**：
```tsx
export function MobileSegmentedTabs({ tabs, active, onChange }: {
  tabs: Array<{ key: string; label: string; count?: number }>; active: string; onChange: (k: string) => void
})
```
- flex border-b bg-card overflow-x-auto 隐藏滚动条（>4 个 tab 自动横滚）；每项 flex-1 min-h-11 whitespace-nowrap px-3 text-sm，激活 text-primary border-b-2 border-primary font-medium，否则 text-muted-foreground；count 徽标 ml-1 rounded-full bg-muted px-1.5 text-[10px]。

**card.tsx / index.ts**：
- MobileCard = div rounded-lg border bg-card p-4（支持 title 头部行：flex items-center justify-between mb-3）。
- src/components/mobile/index.ts 统一导出全部 + re-export Sheet as MobileSheet。

## 2. 主布局接入（S3-W1）

### 2.1 src/app/(main)/layout.tsx 改造

- 新增 import：MobileTabBar / MobileMoreSheet / useIsMobile / usePathname / useState。
- 组件内：const isMobile = useIsMobile()；const isImRoute = pathname.startsWith('/im')（/im 守卫：IM 有自己的 Tab）。
- main 类名追加：isMobile && !isImRoute && 'pb-16'（移动端给 Tab 让位，/im 不让；桌面 lg:pb-6 不变——直接写 'pb-16 lg:pb-6' 组合，由 isMobile 条件拼接）。
- main 之后、AssistantPanel 之前插入移动 Tab 区块：
  `{isMobile && !isImRoute && (<><MobileTabBar items={MAIN_TABS} activeKey={activeKey(pathname)} onAction={(k) => k === 'more' && setMoreOpen(true)} /><MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} /></>)}`
- MAIN_TABS 常量：home 首页 LayoutDashboard href '/'；projects 项目 FolderKanban href '/projects'；todos 待办 CheckSquare href '/todos'；more 我的 UserRound（无 href，onAction 开抽屉）。badge 槽预留后续接未读数。
- activeKey(pathname)：'/' 精确等于 home；/projects 前缀 projects；/todos 前缀 todos；其余一律 more。

### 2.2 src/components/mobile/more-sheet.tsx（"我的"抽屉）

```tsx
'use client'
export function MobileMoreSheet({ open, onClose }: { open: boolean; onClose: () => void })
```
- 用 Sheet 实现；内容三段：
  1. 用户条：头像 initials 圆（bg-primary/10 text-primary）+ 姓名/角色 + 部门；数据 useAuthStore().user。
  2. 导航网格：复用 NAV_GROUPS（从 @/components/layout/sidebar import），过滤规则照抄侧边栏：!g.adminOnly || isAdmin 且 item 满足 !item.pageKey || !pages || pages.includes(item.pageKey) || isAdmin；排除已在底部 Tab 的工作台/项目列表/待办；渲染两列网格（icon + name，min-h-16，active:bg-muted/60 rounded-lg），点击 router.push(href) + onClose。含：项目任务/流程模板/统计图表/采购订单/文件目录/消息 /messages（移动端会被 2.4 重定向到 /im）/管理组 ADMIN（组织架构/外部主体/岗位字典/系统管理）/帮助中心。
  3. 底部操作条：主题切换（复用 next-themes setTheme；六主题横向 chips：浅色/暖阳/晴蓝/薄荷/深色/柔夜，当前主题高亮 border-primary）+ 退出登录按钮（text-destructive h-11；logout() + localStorage.removeItem('auth-token') + router.replace('/login')，照抄 sidebar handleLogout）+ 手机聊天 App 下载入口（/download，样式 border-primary/20 bg-primary/5）。

### 2.3 Header 移动端简化（src/components/layout/sidebar.tsx Header 组件）

- 移动端（lg:hidden 区块）收敛为：汉堡(setMobileMenuOpen) + 标题"项目管理系统"（text-base font-semibold truncate flex-1）+ 通知铃 + 头像。
- 现有 sm:hidden 搜索按钮保留，点击打开的搜索面板容器改 Sheet（MobileSearchSheet：复用现有全局搜索 query/results 逻辑，仅容器与结果行样式移动化，结果行 min-h-14）。
- 桌面区（hidden lg:flex / hidden sm:block）：现状不动。
- 移动汉堡抽屉（mobileMenuOpen 全屏菜单）：保留现有 Sidebar mobile 渲染结构，底色从 bg-card 同步为 bg-[hsl(var(--sidebar))]（与主题分层一致）。

### 2.4 /messages 移动端重定向（src/app/(main)/messages/page.tsx，21 行壳页）

- 加 useIsMobile：移动端 useEffect(() => router.replace('/im'))，渲染期返回轻提示"正在打开消息…"（min-h-dvh flex items-center justify-center text-muted-foreground）；桌面现状（PageGuard messages + 桌面 IM 页）。

### 2.5 AssistantPanel FAB（src/components/ai/assistant-panel.tsx）

- FAB（186 行附近）：fixed bottom-5 right-5 改 fixed bottom-20 right-5 lg:bottom-5。
- 面板（194 行附近）：h-[520px] 改 h-[min(520px,60dvh)]；w-[min(92vw,380px)] 不变。两处类名替换，逻辑零改动。

## 3. 第一批页面规格（S3-W2 至 W4）

### 3.1 工作台 /（783 行，JS 分支）

移动子树 MobileDashboard（新文件 src/components/mobile/dashboard.tsx），页面 return isMobile ? <MobileDashboard .../> : <原桌面 JSX/>（原 JSX 整体不动，仅包 else）：
- 顶部问候：欢迎回来，{user.name} + 日期；右侧统计图表入口 + 新建项目按钮（h-11 w-11 Plus）。
- 统计 4 卡 → 横滑 carousel：flex gap-3 overflow-x-auto px-3 pb-2 snap-x；每卡 min-w-[150px] snap-start rounded-lg border bg-card p-4（数值 text-2xl font-bold + 标题 text-xs text-muted-foreground）；点击行为保留（跳列表/筛选，复用现有跳转 props/回调）。
- 我的待办/我的交付文件/最近项目/最近活动 → 各一节 MobileCard：节头（标题 + 计数 + "全部"跳转），体为 MobileList 展示前 3 条；待办行右侧"处理"按钮 h-11。
- 数据全部复用页面现有 useQuery/props（组件签名接收入参，不重复请求）。

### 3.2 项目列表 /projects（321 行，CSS 分支为主）

- 网格：现有 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 基础上移动单列（默认 grid-cols-1），卡片 min-h-20 p-4，标题/客户/状态 chip/进度条保留。
- 工具行（搜索+筛选+新建按钮）：hidden lg:flex；新建改 MobileFab（Plus icon，onClick 打开现有新建 Dialog——本期保 Dialog 容器）。
- 空态换 MobileEmptyState（icon FolderKanban）。

### 3.3 项目详情 /projects/[id]（952 行，JS 分支）

移动子树 MobileProjectDetail（src/components/mobile/project-detail.tsx）：
- MobilePageHeader：返回 router.back + 项目编号+名称 truncate + 右侧"更多"（Sheet：编辑/归档等管理动作，权限判定复用现有变量）。
- 概览：桌面 dl 三列 → MobileCard 竖排，label text-xs text-muted-foreground + value text-sm font-medium，grid grid-cols-2 gap-3（长文本 col-span-2）。
- 阶段/任务/交付物等子 Tabs → MobileSegmentedTabs（原 Tabs 桌面保留 hidden lg:inline-flex）。
- 阶段列表卡片：阶段名+状态 chip+日期区间+进度条，点击进阶段详情（router.push 现有路由）。
- 任务表格 → MobileList（任务名/负责人 initials/状态/截止）。
- 页面级主操作（新建任务等）：底部固定操作条 fixed inset-x-0 bottom-16 lg:hidden border-t bg-card p-3 flex gap-3（主按钮 btn-gradient flex-1 h-11）——bottom-16 位于 Tab 之上。

### 3.4 阶段/任务子页 /projects/[id]/phases/[phaseId] 与 /projects/[id]/tasks

- MobilePageHeader（返回上一级 router.back）+ 内容卡片化（同 3.3 转换规则）；表格全部 → MobileList；JS 分支。

### 3.5 任务 /tasks（794 行，JS 分支）

- 筛选（项目/状态/负责人/搜索）：移动端收进 header 右槽 Filter 按钮 → FilterSheet（Sheet 内：项目分组列表单选、状态 chips 多选、负责人列表单选、底部重置/应用按钮 h-11）；筛选状态沿用页面现有 useState，应用后触发现有 refetch。
- 任务表 → MobileList：行 = 任务名 truncate + 副行（负责人 initials + 截止日 + 优先级 chip）+ 状态 chip + 右 ChevronRight（muted-foreground/40）。
- TablePagination：hidden lg:flex；移动一次取 50 条 + 触底加载（页面现有分页 state 翻页累积；MobileList 尾部 loading spinner）。
- 任务详情（桌面 Dialog）：移动端 Sheet 展示（内容组件复用，仅容器换）。

### 3.6 待办 /todos（468 行，JS 分支）

- 顶部 Tabs（我的待办/催办中心）→ MobileSegmentedTabs（催办中心带 count 徽标，红色数字）。
- 三分区（催办我的/我催办的/最近已处理）→ 各 MobileCard 节 + MobileList；催办我的行 border-l-2 border-destructive 强调。
- 行操作（撤回催办等）：行右侧文字按钮 h-11 px-3。
- URL ?src=催办 默认选中催办中心 Tab 的现有逻辑保留不动。

### 3.7 采购 /purchase（1454 行，JS 分支，金额/权限敏感重点页）

- 九状态组卡 → 横滑状态 chips：flex gap-2 overflow-x-auto px-3 py-2（MobileStatusChip + count）；点击 = 状态过滤（复用现有 STATUS_GROUPS 过滤 state 与 refetch）。
- 金额汇总（三口径卡）→ 收进 header 右槽"概览"按钮 → Sheet 竖排三卡；金额展示/脱敏完全复用现有组件渲染，不重写口径。
- 订单/请购/供应商 Tabs → MobileSegmentedTabs。
- 订单表 → MobileList：行 = 订单号 + 供应商名 truncate + 副行（状态 chip + 金额 + 下单日）。
- 订单详情（原 Dialog）→ Sheet（maxHeight 90dvh）内嵌现有详情组件（order-status-bar + 明细列表）；审批操作按钮组固定 Sheet footer：主操作（同意/提交）btn-gradient h-11 flex-1，次操作（驳回/退回）outline h-11；驳回理由 textarea 在 Sheet 内容区（focus 自动 scrollIntoView）。
- 新建/编辑表单弹层：移动端 Sheet 化，onSubmit 复用现有提交逻辑。

## 4. 第二批页面要点（S3-W5，一段一页）

- 文件 /files（780 行）：双 Tab（交付计划/项目网盘）→ MobileSegmentedTabs；左树右列表 → "目录折叠列表（DriveExplorer 树改 accordion）→ 点进条目列表"两级 + MobilePageHeader 返回目录级；上传 → MobileFab（Upload）→ 底部 Sheet（选目录 + 文件 input）；条目行（文件名+版本徽章+大小+更新时间）MobileList；批量操作 = 多选模式（行前 checkbox h-11 + 底部操作条替换 Tab 上方）。
- 组织 /organization（788 行）：默认列表视图（部门 accordion + 成员行 MobileList）；MobileSegmentedTabs 切换"列表/结构图"；结构图容器 overflow-auto + touch-action: pinch-zoom（双指缩放）。
- 设置 /settings（1192 行）：sm:/md: 断点统一到 lg；桌面左侧设置导航 → 移动端入口列表页（点进子设置项 MobilePageHeader 返回）；表单组卡片化；QA Cockpit 图表容器 overflow-x-auto + 顶部"左右滑动查看"提示。
- 帮助 /help（158 行）：断点统一 lg；FAQ 手风琴行 min-h-11；微调即可。

## 5. 验收脚本 scripts/mobile-ui-verify.mjs（S4）

playwright chromium 直连 pm.hezongji.cn（或本地 preview），登录态：localStorage 注入 auth-token 后访问。

断言清单（375x812 iPhone 视口）：
- A1 无横向滚动：document.documentElement.scrollWidth <= 375（每页）
- A2 底部 TabBar：nav[data-mobile-tabbar] 存在且 button 数 === 4（页面：/ /projects /tasks /todos /purchase /files）
- A3 触控尺寸：所有 button 与 a 的 getBoundingClientRect 满足 (h >= 44 || w >= 44)；排除 aria-hidden/纯装饰（data-decor）；违规清单输出，阈值 0
- A4 TabBar 不被遮挡：tabbar rect.top < innerHeight 且视口内唯一
- A5 /im 专项：nav 元素总数 === 1（只有 IM 自己的 Tab）
- A6 /im 专项：main 无 pb-16 类
- A7 /projects/[id] 二级页：button[data-mobile-back] 存在
- A8 桌面回归（1280x800）：nav[data-mobile-tabbar] count === 0 且桌面侧边栏 nav 存在
- 输出：每页每项 PASS/FAIL + 违规元素选择器；截图存 .sdlc/active/20260830-mobile-ui/shots/{page}-{vw}.png
- 打点约定（写进组件，一次性）：MobileTabBar 外层 nav 加 data-mobile-tabbar；返回按钮加 data-mobile-back。

## 6. 风险与回滚

| # | 风险 | 缓解 | 回滚 |
|---|---|---|---|
| R1 | /im 双 Tab 或 pb-16 双层 | A5/A6 断言作为 S3 第一个测试点；usePathname 守卫单点实现 | layout.tsx 单文件 revert |
| R2 | 桌面回归（JS 分支误伤桌面） | 桌面分支返回原 JSX 不动；A8 + 桌面截图对比 | 每页独立 commit，按页 revert |
| R3 | 采购金额口径/审批权限 | 详情与操作复用现有组件只换容器（Dialog 到 Sheet）；审批链逻辑零改动；S5 v4-pro 七类必查含金额口径 | Sheet revert 回 Dialog |
| R4 | hydration mismatch | hook 首帧桌面态 + useEffect 修正 | - |
| R5 | 主题硬编码漏网 | 全变量类名；S4 六主题截图抽查（暖阳/深空蓝必查） | - |
| R6 | 旧 md:/sm: 断点与 lg 打架 | 每页改造时同步清理；A1 兜底 | - |
| R7 | WebView 返回栈（IM 跳详情） | 详情页统一 router.back；im 的 pm-back 桥不受影响 | - |

部署节奏：每模块完成 npm run build + 局部 verify + commit（[sdlc:S3-W2] 工作台移动端 风格）；第一批全部完成且 A1-A8 全绿后统一 systemctl restart pm-app 上线（避免中间态线上可见）。回滚 = git revert 对应 commit + rebuild。

## 7. 工件与文件清单（S3 实施清单）

新增：
- src/hooks/use-is-mobile.ts
- src/components/ui/sheet.tsx
- src/components/mobile/{tab-bar,page-header,list,status-chip,empty-state,search-bar,fab,segmented-tabs,card,more-sheet,dashboard,project-detail}.tsx + index.ts
- scripts/mobile-ui-verify.mjs

修改：
- src/app/(main)/layout.tsx（TabBar + pb-16 + /im 守卫）
- src/components/layout/sidebar.tsx（Header 移动端简化 + 汉堡抽屉底色 --sidebar）
- src/app/(main)/messages/page.tsx（移动重定向 /im）
- src/components/ai/assistant-panel.tsx（FAB bottom-20 + 面板 60dvh）
- 第一批页面：工作台 / 项目列表 / 项目详情 / 阶段 / 任务 / 待办 / 采购 各 page.tsx
- 第二批页面：files / organization / settings / help

不动：src/components/im-mobile/**、src/app/im/**、全部 src/app/api/**、prisma schema、桌面端任何交互逻辑。
