# Plan: IM App 深度微信化（v1.2 迭代）

- **Change-ID**: 20260829-im-app-v3 · **阶段**: S3 · **状态**: draft（待 v4-pro 架构审 + owner 审阅）
- **依据**: intent.md + spec.md v2（owner 拍板 6 决策点 + v4-pro 审 P0-1/2/3、P1-4/5/6/7 已落实）

## 工作分解（约 10.5 天）

### W1 · 后端准备（1.5 天，可先行，完成即部署）
- **微迁移 4 处**：ConversationMember + isPinned/hiddenAt；Conversation + announcement/announcementAt；MsgType + VOICE（主 schema + im-server schema 同步 + prisma generate 双端）
- **REST 端点 4 个**：
  - `PATCH /api/conversations/:id/prefs {isPinned?, muted?, hiddenAt?}`（按 conversationId_userId 复合键 update，userId 只取 token 不得来自 body；非成员 403，照抄 read 路由 catch→403 模式）
  - `PATCH /api/conversations/:id/announcement {content}`（权限用 **requireManageRole（OWNER/ADMIN）**——v4-pro I6，非解散路由的 OWNER-only）；事务内 `tx.message.create(SYSTEM「群公告已更新」)` + touch lastMessageAt + `pg_notify('im_events',{event:'message:new'})`（照抄 reports/issues 既有模式）；announcement 加进 GET /conversations 响应
  - `POST /api/im/voice-upload`（≤2MB + audio mime 白名单 → im-voice/{uuid}.webm）
  - `GET /api/im/voice/:uuid`（requireAuth + uuid 白名单 + audio/webm）
- **GET /conversations 响应升级（v4-pro I5，W2/W3 依赖）**：加 `myPrefs{isPinned,muted,hiddenAt}`，unread cutoff=max(lastReadAt, hiddenAt)
- **im-server 3 行守卫**：mentions.length > 20 跳过 TodoItem（保留 Notification）；**W1 完成即部署 im-server**（守卫提前生效；VOICE 枚举同步，旧 client 不受影响）
- 证明测试：tsc/build + prisma migrate deploy + 端点 node 断言（prefs CRUD/非成员 403/announcement 权限 403/voice 上传下载 round-trip）

### W2 · 三 Tab 结构 + 通讯录 + 我的（2 天）
- `ImAppShell`（im/page.tsx 重构）：底部 Tab 栏（聊天/通讯录/我的）+ Tab 状态切换；聊天 Tab 未读总角标（sum unread 排除 muted）
- `contacts-view.tsx`：组织架构（org-chart API）部门树 + 成员列表 + 点人发起单聊（POST SINGLE 复用）
- `me-view.tsx`：头像/姓名/角色 + 退出登录 + 下载页入口
- 证明测试：headless 三 Tab 切换 + 通讯录树 + 点人单聊 e2e；截图走查

### W3 · 会话列表增强（1.5 天）
- conversation-list 升级：置顶分组（灰底分隔）/ muted 灰点 / 长按菜单（置顶/免打扰/删除）/ 搜索栏 / 下拉刷新 / hiddenAt 过滤（新消息自动复活，unread cutoff = max(lastReadAt, hiddenAt)）
- 证明测试：e2e（置顶排序/prefs 持久化/删除后新消息复活）+ 截图走查

### W4 · 聊天页细节 + 多选转发删除 + emoji 增强（2 天）
- 时间分隔线（>5min 插入）、聊天背景 #EDEDED、输入栏语音切换按钮（**占位：点击 toast「语音即将上线，请更新 App」**——v4-pro I4，老壳用户不可用）、双击头像@、长按菜单增强（删除/多选/转发）、多选模式 + 底部操作条、渲染层过滤 deletedIds（localStorage，**500 条截断**）、emoji 面板分类增强（笑脸/手势/生活/符号，intent 承诺项）
- 证明测试：headless 交互走查（时间线/双击@/多选/删除过滤）+ 截图

### W5 · 语音消息 + 壳改动 + 出包（2.5 天）
- 前端：按住说话录音（**60s 自动截断发送** + 上滑取消 + visibilitychange/中断取消 + ≤2MB 预检；isTypeSupported 级联）→ voice-upload → socket type='VOICE' fileMeta={voiceId,duration,size}；**VoiceBubble 用 fetch→blob→URL.createObjectURL 模式（Bearer 鉴权坑，<audio src> 直链必 401）**，blob 预取使 play() 落在用户手势内；录音失败 toast「请到 我→下载页 更新 App」（老壳引导）；桌面 message-bubble `case 'VOICE'` + previewText `[语音]`
- 壳层（**一次出包，含 W6 图片多选壳改动**——v4-pro I1）：manifest RECORD_AUDIO + 运行时权限 + onPermissionRequest 授予 RESOURCE_AUDIO_CAPTURE + `EXTRA_ALLOW_MULTIPLE=true`（API<Q accept=image/* 不再直跳相机，相机仅 capture=true 触发）→ **APK v1.2（versionCode 3）重出并上架下载页**
- **部署顺序：im-server 先于 Web 层重启**（VOICE 枚举校验，顺序颠倒则发送全失败）
- 证明测试：接口层 e2e（上传/读取 round-trip + **token 拉取→objectURL 可解码断言**）；录音与播放为**真机半人工验收**

### W6 · 群功能 + 图片能力（2.5 天）
- @所有人（联想顶部「所有人」→ 展开成员 mentions；>50 人二次确认）
- 群公告横幅（进群展示 + 可收起；发布入口仅 OWNER/ADMIN）
- 图片多选（≤9 张，input `multiple` + 遍历 files，一次 UploadPicker + 顺序 await 逐张上传发送，单张失败继续汇总）
- 图片黑底全屏浏览（自实现滑动/页码/保存；保存经 fetch→blob 桥接）
- 证明测试：e2e（@所有人通知/公告发布可见/多选上传）+ 截图走查

### W7 · 全链验证（0.5 天）
- 全链 e2e（含 v1.1 回归：附件归档/文件移动）+ verify-im-app 补断言 + 真机验收清单（**W7 只回归不出新包，APK 在 W5 已上架**）

## 工作顺序

W1（后端）→ W2（结构，依赖 W1 prefs）→ W3（列表）→ W4（聊天细节）→ W5（语音+壳+出包）→ W6（群+图片）→ W7（收口回归）
- W1 后端派子代理 worktree 先行（与 W2 并行）；W2-W4 主会话串行（UI 精细迭代）；W5 壳改动由子代理并行准备（Kotlin 文件与前端零冲突）
- 每一 W 完成即部署上线（Web 层即时生效），APK 仅 W5 出包一次（含 W6 多选壳改动，v4-pro I1）
- 关键路径串行约 12.5 天；两条并行线全成立时收敛 10.5 天

## 风险清单

| # | 风险 | 影响 | 缓解 |
| - | ---- | ---- | ---- |
| 1 | WebView 录音兼容性（Android 版本/机型） | 语音不可用 | isTypeSupported 级联 + 壳权限三项前置 + 真机半人工验收 |
| 2 | @所有人通知/待办洪泛 | 全员待办爆炸 | mentions>20 守卫（只通知不待办）+ >50 人二次确认 |
| 3 | 消息删除与重取冲突 | 已删消息复活 | 渲染层过滤约束（P1-6）+ 幽灵未读标注已知限制 |
| 4 | 群公告传播不及时 | 成员感知慢 | pg_notify SYSTEM 消息刷 lastMessage + 10s 轮询兜底 |
| 5 | 双端共享组件回归 | 桌面 IM 故障 | 每个 W 跑 b2-im-notify-chain e2e；桌面截图走查 |
| 6 | 语音孤儿文件无 GC | 磁盘增长 | ≤2MB/条 + 一期接受（会话解散残留） |
| 7 | 同名成员 @错人 | @错对象 | v1.1 既有已知限制，标注不修（二期姓名拼音） |

## 版本依据
- 零新增 npm 依赖；图片浏览/emoji 自实现
- APK v1.2：versionCode 3 / versionName 1.2.0（复用现有 keystore）

---
> 闸门：v4-pro 架构审通过 + owner 审阅通过 → commit = approved，触发 S4 Build。
