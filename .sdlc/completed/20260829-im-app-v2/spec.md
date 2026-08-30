# Spec: IM App 微信化改造 + 附件项目归档（v1.1 迭代）

- **Change-ID**: 20260829-im-app-v2 · **状态**: owner已拍板5决策点（2026-08-29）+ v4-pro架构审通过（I1-I5已落实本版）
- **依据**: intent.md（owner 2026-08-29 真机验收后提出）

## 现状盘点（2026-08-29 读码侦察）

| 项 | 现状 | 结论 |
| -- | ---- | ---- |
| 文件归档数据模型 | File.projectId **必填**，storagePath=`{root}/{projectId}/{catalogId}/{uuid}.{ext}`，FileCatalog 项目目录树（多级） | ✅ **「附件按项目归档」数据侧已天然满足**，无需改表 |
| 上传链路 | 网页端已有完整链路：选文件 → 拉会话项目目录树 → 选目录 → `POST /api/files/upload`(multipart+catalogId，后端从 catalog 反查 projectId + 权限校验) → socket 发消息带 fileMeta | 移动端代码同链路可用（未真机验证）；**限制：上传要求会话已关联项目** |
| 消息文件元数据 | Message.fileMeta 为 **JSON 字段**（name/size/mimeType/fileId） | ✅ 可扩展 projectId/projectName/catalogName，**不动表结构** |
| 群成员数据 | conversation.members（头像/姓名/角色）已返回，移动端仅显示人数 | 需成员抽屉 UI |
| PC 文件移动 | files/[id] 仅 DELETE；**无移动 API** | 需补 PATCH move 端点 + files 模块入口 |
| 移动端 UI | /im 页 = 桌面双栏应急改造（列表↔聊天切换态） | 需按微信范式重构 |

## 方案设计

### 一、移动端微信化 UI 重构（P0，约 3 天）

**改造路径定案（v4-pro I4）**：两步走，各自设闸门——
1. 第一步：抽纯逻辑 hooks（useConversations / useChatSocket / useMessages / 上传发送），桌面 markup 改为消费 hooks、行为不变；**闸门 = 现有 IM 链 e2e 全绿**
2. 第二步：新建 `im-mobile/` 组件目录消费同一 hooks，不再在共享文件堆 isMobile 分支；**闸门 = 桌面零回归 + 移动端截图走查**

**会话列表页**（微信首页式）：
- 顶部标题栏：返回箭头（进入时隐藏）+「PM 聊天」+ 右上角「发起聊天」（现有 MemberPicker 复用）
- 列表项：圆形头像（ImAvatar）+ 会话名 + 最后消息预览 + 相对时间 + 未读红点（数据现有，样式微信化）
- 列表按 lastMessageAt 排序（现有）

**聊天页**：
- 顶部：返回箭头 + 会话名（**点击标题 → 群成员抽屉**）
- 消息区：气泡微信化——我方右侧绿色、对方左侧白色，对方显示头像+群内昵称，我方不显示；连续消息合并（简化版：间距收紧）
- 底部输入栏：**+ 号按钮**（点击弹出面板：相册 / 拍照 / 文件，微信式）+ 输入框（@ 联想已有，加**系统 emoji 面板**入口）+ 发送按钮
- 长按消息 → 操作菜单：复制 / 引用回复 / 撤回（2 分钟内自己的消息）

**移动端关键体验项（v4-pro I3，intent 点名项必须入验收）**：
1. **键盘三态**：键盘弹起（adjustResize 视口变化）时重新滚底；+ 面板与键盘互斥开启不叠加遮挡
2. **安全区**：全局 viewport 加 `viewportFit:'cover'` + 底部输入栏/顶栏用 `env(safe-area-inset-*)`，避免手势导航条与输入栏重叠
3. **滚动策略**：上翻历史时暂停自动滚底 + 出现「新消息」pill 点击回底；上拉加载更早历史（limit=50 分页，归 P1）
4. **长按冲突**：消息区 `user-select:none` + 长按阈值，避免与浏览器文本选择柄/图片系统菜单冲突；修复现有回复/撤回按钮 `opacity-0 group-hover` 在触屏不可见但仍可点的缺陷（改触屏常显或长按菜单）

**群成员抽屉**：
- 从右侧滑入面板：会话名 + 成员数 + 成员列表（头像/姓名/角色徽标 + 群主标记）
- 数据现成（conversation.members），纯前端组件

**涉及文件**（预估）：`src/components/im/use-im-hooks.ts`（新 hooks）、`src/components/im-mobile/`（新目录：conversation-list / chat-view / member-drawer / plus-panel / message-bubble-mobile）、`src/components/im/message-bubble.tsx`（触屏按钮缺陷修复）、`src/app/layout.tsx`（viewport-fit）、`src/components/im/utils.ts`（FileMeta 类型扩展）

### 二、附件上传 + 项目关联（P1，核心需求，约 2 天）

**交互流程**（移动端 + 号面板「文件」/「相册」入口，一期单文件）：
1. 选文件（系统选择器，onShowFileChooser 壳层已支持；**一期单文件，多选二期**——v4-pro N4）
2. **单弹层合并选择（v4-pro N3）**：底部弹层上半部项目列表、下半部选中项目的目录树——「选项目+选目录」一步完成；**会话已关联项目时预选该项目+记住的上次目录**（一键确认路径）
3. 上传（进度提示）→ 发送消息

**项目选择器权限（v4-pro I5）**：
- 列表 = GET /api/projects 返回的我参与项目，**按 myRole 过滤**：view≠upload，无 upload 权限角色（VIEWER）置灰标注「无上传权限」；ADMIN 放行
- 隐藏/禁用 isArchived 项目

**数据方案**（v4-pro 证实零后端改动）：
- 上传走现有 `POST /api/files/upload`（catalogId → 反查 projectId 落库，storagePath 自动按项目归档）
- 前端发送消息时 fileMeta 扩展：`{name,size,mimeType,fileId, projectId, projectName, catalogName}`——Message.fileMeta 为 JSON，im-server handler 整体透传无白名单，REST 原样返回，**0 改动**
- **消息文件卡片**：FILE 类型显示文件名 + 大小 + 「📁 {projectName}/{catalogName}」归属行；**IMAGE 气泡不显示归属行**（与 FILE 卡片口径分开，v4-pro N2）；老消息缺新字段不渲染归属行（兼容）
- 会话未关联项目也可上传（解除现有限制）；单聊/群聊通用
- projectName/catalogName 为发送时快照，改名后历史卡片显示旧名（display-only，可接受——v4-pro N1）

### 三、PC 端文件移动（P2，一期交付，约 1 天）

**方案定案（v4-pro I1/I2，替代原「仅更新 DB」错误回退分支）**：
- 新端点 `PATCH /api/files/:id/move { catalogId }`：
  - **仅接受计划外文件**（requirementId=null）；条目文件（挂在交付计划条目下）返回 400（移动会与 requirement.catalogId 矛盾、绕过条目审核语义）
  - 权限：`requireCan('upload', PROJECT)`（与上传同级，非 view）；归档项目拒绝移动（对齐 upload/delete 现有拦截）
  - 实现：`fs.rename` 物理迁移（FILE_ROOT 单卷永远同盘，原子零成本）+ 事务内 update storagePath（新路径 = `{projectId}/{新catalogId}/{原uuid}.{ext}`）+ 失败双向回滚
  - 留痕：FileAccessAction 枚举加 `MOVE` 值（微迁移）并写 FileAccessLog
- files 模块（PC 网页）文件行加「移动到…」操作（单选 + 批量）
- 手机端不做移动（owner 明确）

### 四、项目选择能力

- App 内「项目选择器」为上传流程的子组件；若 owner 需要 App 首页切换项目视图（按项目筛选会话/文件），列为 P2 扩展

## 分阶段计划

| 阶段 | 内容 | 预估 | 闸门 |
| ---- | ---- | ---- | ---- |
| P0 | 微信化 UI 重构（hooks 抽取→im-mobile 新目录：会话列表/气泡/输入栏/+面板/长按/成员抽屉/键盘三态/安全区/滚动策略） | 3 天 | hooks 步：IM 链 e2e 全绿；UI 步：桌面零回归+真机截图走查 |
| P1 | 附件上传 + 强制项目关联（单弹层选项目+目录/卡片归属展示/历史上拉加载） | 2 天 | e2e：上传落库归属断言 |
| P2 | PC 文件移动 API + 入口 | 1 天 | 移动后 files 模块可见可下载 |
| P2x | 项目视图/语音消息/表情包 | 二期另议 | — |

**总计约 6 天。**

## owner 确认关口（S2 闸门）

| # | 决策点 | 选项 A | 选项 B | 推荐 | owner 拍板 |
| - | ------ | ------ | ------ | ---- | ---------- |
| 1 | 项目选择范围 | 我参与的项目 | 全部项目 | **A**（权限一致，非成员不可传） | ✅ **A**（2026-08-29） |
| 2 | 上传默认目录 | 记住上次选择 | 每次默认项目根目录 | **A**（同项目连续上传体验好） | ✅ **A**（2026-08-29） |
| 3 | 语音消息 | 一期做（WebView 录音→上传） | 二期再做 | **B**（录音+播放体验打磨成本高） | ✅ **B**（2026-08-29） |
| 4 | 表情 | 系统 emoji 面板（输入框旁） | 图片表情包 | **A**（零素材成本） | ✅ **A**（2026-08-29） |
| 5 | PC 文件移动 | 一期一起交付 | 二期再做 | **A**（资料整理闭环，成本低） | ✅ **A**（2026-08-29） |

## 验收断言（S4 逐项验证）

- [ ] 移动端会话列表：头像/时间/未读红点微信式展示（截图走查）
- [ ] 群聊标题点击出成员抽屉，成员/角色正确
- [ ] 移动端上传：选文件→单弹层选项目+目录→上传→消息出现文件卡片，卡片含「项目/目录」归属
- [ ] 上传落库断言：File.projectId/catalogId 正确，storagePath 按项目归档
- [ ] 会话未关联项目时上传仍可用（强制选项目）
- [ ] VIEWER 角色项目选择器置灰不可传（接口层 403 断言）
- [ ] 键盘弹起滚底正常、+面板与键盘不叠加、安全区无遮挡（真机三态走查）
- [ ] 上翻历史暂停滚底 + 新消息 pill；上拉加载更早历史
- [ ] 桌面 /messages 零回归（现有 IM 链 e2e 全绿）
- [ ] PC 移动：计划外文件 move 成功且下载可用；条目文件 move 返 400；归档项目拒绝

---
> 闸门：v4-pro 架构审通过（I1-I5 已落实本版）+ owner 已拍板全部决策点 → commit = approved，触发 S3 Build。
