# Intent: PM-IM 独立聊天 App（Android APK + iOS，消息自动同步 PM）

- **Change-ID**: 20260829-im-standalone-app
- **作者**: owner · **状态**: draft（待 owner 审校拍板）
- **来源**: ☑ 人的想法（owner 原话：把 PM 项目中的 IM 模块和功能分离出来，做一个独立的聊天软件，打包成 APK 和 iOS 两种，公司成员用这个 IM 聊天软件交流沟通，所有消息自动同步到 PM 项目管理系统）

## 问题（Why）

公司成员沟通依赖 PM 网页内的 IM 模块，但 PM 是管理系统，入口重、需登录网页、无手机端体验。员工需要：

1. 一个装在手机上的、打开即聊的聊天软件（像微信/钉钉一样的独立 App 入口）；
2. 消息必须与 PM 系统完全同步——电脑上 PM 网页发的消息手机上要看到，反之亦然；
3. 双端形态：Android APK + iOS。

**关键架构洞察（侦察确认）**：IM 后端已是独立进程（im-server，Socket.IO :3002），且与 PM 主服务**共享同一 PostgreSQL 库的 `Conversation / ConversationMember / Message` 表、共享同一 JWT_SECRET 签发体系**。因此"独立 App"天然共享同一消息数据源——**无需任何同步机制，消息天然同步**。App 本质只是"换一个客户端壳"。

## 期望结果（What）

公司员工在手机上通过独立聊天 App（Android APK / iOS）登录 PM 账号，收发消息、看会话列表/未读/在线状态，所有消息与 PM 网页 IM 实时互通。PM 网页 IM 保持现状不动。

## 成功标准（怎么算对）

- [ ] 员工手机安装 App 后，用现有 PM 账号（邮箱/用户名/姓名 + 密码）即可登录，无需另建账号体系
- [ ] App 内收发消息与 PM 网页 `/messages` 实时互通（<2s 可见，同一会话同一数据源）
- [ ] Android 产出可分发的 APK；iOS 产出按拍板策略落地（见约束区）
- [ ] 会话列表/未读红点/历史消息/已读/在线状态五类核心功能可用
- [ ] PM 网页端 IM 功能零回归（改不动主站 IM 数据链路）
- [ ] 验收断言脚本 TODO：spec 阶段补齐（复用 im-server `scripts/test-e2e.js` 思路，对 App 端 socket 握手+收发做联调断言）

## 范围

- **做**:
  - S1-S2 方案设计（本变更）：技术路线选型、iOS 策略、推送方案、架构设计文档
  - 后续 S3+（待 owner 拍板路线后另立变更）：App 壳/客户端开发、登录接入、IM 专页改造、打包分发
- **不做（非目标）**:
  - ❌ 改动 im-server 核心链路与 PG 表结构（除非 spec 论证必要）
  - ❌ 新建消息同步机制（同库同源，无此需求）
  - ❌ 重做 PM 网页版 IM 的 UI/功能
  - ❌ 通讯录/组织架构独立体系（沿用 PM 现有用户体系）
  - ❌ 音视频通话、朋友圈等超出 IM 范畴的功能
  - ❌ 本变更内不做任何业务代码开发与部署

## 约束（硬约束区，影响路线可行性的现实边界）

1. **iOS 分发硬约束**：无 Apple 开发者账号（$99/年）则 iOS 无法对员工真机分发——TestFlight、AdHoc（100 台/年）、企业签（$299/年，需 D-U-N-S 企业资质且仅限公司内部员工）全部需要付费开发者账号。免费 Apple ID 只能 7 天临时签名自用设备，不适合全员分发。**零成本 iOS 现实选项只有一条：PWA/WebClip 添加到主屏**（PM 已有 manifest.json，standalone 模式）。owner 现成的 Android 自签分发渠道（先例：D:/pi-mobile-app 的 WebView 方案，本机直发 APK）仅覆盖 Android，不解决 iOS。
2. **员工手机环境未知**：公司成员安卓/iOS 占比未调研，iOS 策略的成本决策（是否值得花 $99/年）依赖此数据。spec 阶段需 owner 提供或授权问卷调研。
3. **离线推送合规约束**：国内安卓厂商推送通道（华为 HMS/小米/OPPO/vivo）需要企业开发者资质，或接入第三方聚合 SDK（极光 JPush/个推 Getui，需企业资质注册，有免费额度）。iOS 推送（APNs）本身也依赖开发者账号。不接推送的现实兜底 = 打开 App 时补拉未读（现有 `GET /api/conversations` 聚合 unread 机制已支持）。
4. **网络可达性**：App 需访问 im-server（socket）与主服务 REST API——现公网域名 pm.hezongji.cn（nginx 已代理 `/socket.io/`→:3002、`/api`→:3001）可直接复用，无需新开域名/端口。
5. **认证不另起炉灶**：沿用 PM 账号与 JWT 体系（同库、同 JWT_SECRET、30 天过期），不建第二套账号。

## 受影响用户与系统

- **用户群**：公司全体员工（手机端）；PM 网页 IM 用户不受影响
- **涉及服务**：im-server(:3002)、PM Next.js 主服务(:3001)、共享 PG 库（Conversation/ConversationMember/Message/User 表）、nginx(pm.hezongji.cn)
- **新增**：App 客户端工程（壳/原生/PWA 之一，待拍板）、可选推送 SDK 接入

## 未决问题（S2 前需 owner 决断/提供）

1. 技术路线（WebView 壳 / RN+Expo / PWA 三选一或组合）
2. iOS 策略（注册 $99 开发者账号 vs 零成本 PWA 兜底 vs 暂缓 iOS）
3. 推送方案（极光/个推 vs 厂商通道自建 vs 无推送仅补拉）
4. 员工手机安卓/iOS 比例（可后置：先出 Android，iOS 按占比定策略）

## 调研附录

- 侦察摘要（2026-08-29 现场读码）：im-server 独立进程（Socket.IO :3002，PG prisma 共享主库表，JWT HS256 与主服务同密钥，PG LISTEN/NOTIFY im_events 联动 REST 落库事件）；前端 `/messages` 页 913 行 + `socket-provider.tsx` 166 行（zustand + react-query + socket.io-client，深度耦合 Next.js 路由/别名体系）；`POST /api/auth/login` 返回 `{user, token}`；PWA 现状 = manifest.json 有（standalone）但 sw.js 为自卸载桩（无离线缓存、无推送注册）；nginx 已备 im.hezongji.cn 域名（当前指向 :8080 待改）。
- 外部调研（分发/推送合规口径）：TODO——spec 阶段如需精确到厂商资质条款，派 qwen3.8-max 调研子代理补充。

---
> 闸门：owner 审校本文件 → 修正 → `git commit` = accepted，触发 S2 Design。
