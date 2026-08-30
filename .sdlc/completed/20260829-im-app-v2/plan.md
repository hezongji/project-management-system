# Plan: IM App 微信化改造 + 附件项目归档（v1.1 迭代）

- **Change-ID**: 20260829-im-app-v2 · **阶段**: S3 · **状态**: 修订版 v2（已落实 v4-pro 审 F1-F5，待 owner 确认开工）
- **依据**: intent.md + spec.md v2（owner 拍板 5 决策点 + v4-pro 审 I1-I5 已落实）

## 工作分解（按 spec v2，约 6 天）

### W1 · hooks 抽取（P0 第一步，0.5 天，闸门=e2e 全绿）
- 从 `messages-page-inner.tsx`（~940 行）抽纯逻辑 hooks 到 `src/components/im/use-im-hooks.ts`：
  - `useConversations`（列表查询/invalidate）
  - `useChatSocket`（socket 连接 + message:new/read:sync/conv:created/connect_error）
  - `useMessages`（会话消息查询 + selectedId 管理 + readUserIds）
  - `useMessageSend`（发送/回复/撤回/上传发送）
- 桌面 markup 改为消费 hooks，**行为零变化**
- **W1 验收三条不变量（v4-pro F5，防漂移必守）**：
  ① socket effect 依赖只允许稳定引用，selectedId 必须走 ref 传入（否则每次切会话 socket 重连/掉消息）
  ② read:sync → setReadUserIds 以 useState setter 直传（天然稳定），禁止未 memo 回调进 effect deps
  ③ draft/replyTo/mention 清空留在组件层；useMessageSend 只暴露 `sendText({conversationId,content,replyToId,mentions})` + revoke + uploadSend，不带编辑器态
- 证明测试：`b2-im-notify-chain.mjs` 全绿 + 桌面 headless 走查（复用现有脚本）

### W2 · 移动端微信化 UI（P0 第二步，2.5 天）
- 新建 `src/components/im-mobile/`（消费 W1 hooks）：
  - `conversation-list.tsx`：微信式会话列表（头像/时间/未读红点/标题栏/发起聊天）
  - `chat-view.tsx`：聊天页（气泡/输入栏/+面板/长按菜单/标题点击成员抽屉）
  - `member-drawer.tsx`：右侧滑入成员面板（头像/姓名/角色/群主标记）
  - `plus-panel.tsx`：+ 面板（相册/拍照/文件，一期单文件）
  - `message-bubble-mobile.tsx`：微信式气泡（我方右绿/对方左白+头像+群昵称）
- `/im` 页切换到新组件树；`messages-page-inner.tsx` 的 mobile 分支退役
- 移动端体验四项（键盘三态/安全区/滚动策略/长按冲突）：
  - `src/app/layout.tsx`：viewport `viewportFit:'cover'`；输入栏/顶栏 `env(safe-area-inset-*)`
  - 键盘弹起重滚底；+面板与键盘互斥
  - 上翻暂停滚底 + 新消息 pill（P1 做上拉加载）
  - `user-select:none` + 长按阈值；修复 message-bubble 触屏隐藏按钮缺陷
- 证明测试：headless 390×844 截图走查（会话列表/聊天页/成员抽屉/长按菜单）+ 桌面 /messages 零回归截图

### W3 · 附件上传 + 强制项目关联（P1，2 天）
- 上传交互重做：
  - + 面板「文件/相册」→ 选文件 → **单弹层**（上半部项目列表、下半部目录树；会话项目预选+记住上次目录）→ 上传 → 发送
  - 项目选择器数据：`GET /api/projects?limit=100`（v4-pro N3）；目录树：`GET /api/projects/:id/catalogs`
  - **灰显规则（v4-pro F1）**：myRole ∈ {OWNER, ADMIN} 放行，其余（MANAGER/MEMBER/VIEWER）置灰「无上传权限」；ACL 特批用户由选中后 `GET /api/projects/:id` 的 perms.upload 兜底放行
  - 隐藏/禁用 isArchived 项目
  - 记住上次：localStorage `im-upload-pref:{projectId}` 存最近 catalogId
- fileMeta 扩展：发送时附 `projectId/projectName/catalogName`；`utils.ts` FileMeta 类型扩展
- 文件卡片：FILE 显示「📁 项目/目录」归属行；IMAGE 不显示；老消息兼容
- 解除「会话必须关联项目」限制
- **历史上拉加载（v4-pro F4 定案）**：`useInfiniteQuery` + 现有 `before` 游标（API 已支持 createdAt+id 双键 + hasMore/nextBefore，上限 100），禁止新增 offset 参数；桌面与 im-mobile 共用同一 infinite query
- 证明测试：e2e 断言（上传→storagePath 前缀含 projectId/catalogId→消息 fileMeta 含归属→卡片渲染）+ OWNER 可传 / MANAGER 置灰 + 接口 403 断言

### W4 · PC 文件移动（P2，1.5-2 天）
- 后端：`PATCH /api/files/:id/move { catalogId }`：
  - 仅接受 requirementId=null（计划外文件）；条目文件 400
  - **同项目守卫（v4-pro F3）**：`catalog.projectId !== file.projectId → 400`（跨项目移动会致 storagePath 与 DB projectId 脱钩，配额/可见性/归档判定全失真）
  - 权限：requireCan('upload', PROJECT)；归档项目拒绝
  - 实现：fs.rename 物理迁移 + 事务内 update storagePath + 失败双向回滚；**并发防护（v4-pro N4）**：updateMany({where:{id, storagePath:旧}}) 判 count===1 再提交；回滚失败 CRITICAL 日志
  - 留痕：FileAccessAction 加 `MOVE` 值（迁移有先例）+ FileAccessLog
- **计划外文件列表端点（v4-pro F2，范围缺口补齐）**：新增 `GET /api/files?projectId=&catalogId=`（requireCan view；where: { requirementId: null, storagePath: { startsWith: projectId+'/'+catalogId+'/' } }，不加列）
- 前端：files 页目录选中态加「临时文件」小节 + 「移动到…」（目录树选择弹层，单选+批量=前端逐个 PATCH+汇总 toast）
- 证明测试：e2e（计划外文件 move→下载可用→目录删除守卫正确；条目文件 400；跨项目 400；MANAGER 403）

### W5 · 全链验证 + 出包（0.5 天）
- **部署序列（v4-pro N8）**：`prisma migrate deploy`（MOVE 枚举）→ next build → 重启 → e2e → 出包
- `scripts/verify-im-app.mjs` 补 v1.1 断言；全链 e2e；`build-apk.sh` 参数化 APK_VERSION（v4-pro N2）出 v1.1 APK（versionCode 2 / versionName 1.1.0）→ 部署 `/opt/pm-app-downloads/` → 下载页版本号/SHA 更新
- **发布预案（v4-pro N7）**：v1.1 发布 = 通知全员重新扫码下载（无版本检查机制，一期接受）；回滚路径 = git revert + 重建部署，W5 验证通过后写入发布通知模板
- 真机验收清单交 owner（S5 GO/NO-GO）

## 工作顺序与并行

W1（hooks）→ W2（UI，依赖 W1）与 W4（后端，独立可并行）→ W3（上传，依赖 W2）→ W5（收口）
- 并行度：W2（前端）与 W4（后端 files API）由两个子代理 worktree 隔离并行；W1 由主会话做（桌面零回归风险最高，主会话全上下文）
- W3 依赖 W2 的 + 面板与弹层组件，串行

## 风险清单

| # | 风险 | 影响 | 缓解 |
| - | ---- | ---- | ---- |
| 1 | hooks 抽取引入桌面回归 | PM 网页 IM 故障 | W1 闸门=现有 e2e 全绿才进 W2；三条不变量（F5）写进验收 |
| 2 | 移动端长按/滚动手势与 WebView 原生手势冲突 | 体验差 | WebView 默认无拦截，JS 层阈值控制；真机走查必测 |
| 3 | fs.rename 跨目录失败（权限/占用） | 文件移动 500 | FILE_ROOT 单卷同盘；事务回滚 + CRITICAL 日志；e2e 覆盖 |
| 4 | ~~历史分页 API 不支持~~（v4-pro F4：已支持 before 游标，风险解除） | — | useInfiniteQuery + before 游标 |
| 5 | 移动端 UI 与桌面共享组件耦合反弹 | 回归面扩大 | 严格走 im-mobile/ 新目录，禁止共享文件内新增 isMobile 分支 |
| 6 | 相册多选预期 | 员工想一次发多张 | 一期单文件（已定），UI 明示；二期循环上传 |
| 7 | 老 APK 用户无版本检查（v4-pro N7） | v1.1 发布靠重扫 | 发布=通知全员重扫 + git revert 快速回滚预案 |

## 已确认事项（v4-pro 审收口）
- W3 上传权限：项目内仅 OWNER/ADMIN 可传计划外文件（permission.ts 证实）——上传按钮权限语义与 PC 端一致
- 头像（v4-pro N6）：ImAvatar 现仅首字母圈；微信式头像需渲染 members[].avatar 照片（有值用照片，无值回退首字母）——已入 W2 范围
- im-mobile 不做 ?conversation=/?focus= URL 定位（壳只 loadUrl 裸 /im，v4-pro N5）

## 版本依据
- 不新增 npm 依赖（emoji 面板用系统/原生实现）；不引入新框架；prisma 仅加一个枚举值迁移
- APK v1.1：versionCode 2 / versionName 1.1.0（复用现有 keystore）

---
> 闸门：v4-pro 架构审通过（F1-F5 已落实本版）+ owner 确认 → commit = approved，触发 S4 Build。
