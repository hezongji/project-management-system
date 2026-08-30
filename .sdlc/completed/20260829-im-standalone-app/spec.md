# Spec: PM-IM 独立聊天 App（Android APK + iOS，与 PM 消息天然同步）

- **Change-ID**: 20260829-im-standalone-app · **状态**: approved（owner 拍板 2026-08-29，见关口表；v4-pro 架构审移至 S3 plan.md 闸门执行）
- **上游**: intent.md（draft，同批提交） · **架构**: 主会话 GLM 展开（重大架构，S3 前补 v4-pro 背靠背审与仲裁）

## 方案概述

核心结论先行：**im-server 与 PG 库全量复用，App 只是"第三个客户端"**。IM 后端已是独立进程且与 PM 主服务同库同密钥（侦察确认：共享 `Conversation/ConversationMember/Message` 表 + 同 JWT_SECRET + PG LISTEN/NOTIFY 联动），独立 App 连上同一 socket 与同一组 REST 即可获得天然同步，**零同步机制**。

本 spec 给出三条客户端技术路线（A WebView 壳 / B RN+Expo / C PWA）供 owner 拍板，并逐方案给出 iOS 现实路径；推送、认证、专页路由为三路线共性设计。

## 一、技术路线三方案对比

| 维度 | 方案 A：WebView 套壳 App | 方案 B：React Native + Expo 跨端 | 方案 C：PWA 主屏安装 |
| --- | --- | --- | --- |
| 一句话 | 壳工程加载 IM 专页（Capacitor/Cordova 或原生 WebView） | 真原生 App，RN 重写 IM 前端 | PM 已有 manifest，改造后"添加到主屏" |
| 开发量估算 | **1-3 人日**（壳工程 0.5-1 天 + /im 专页改造 0.5-1 天 + 打包联调 1 天） | **2-4 周**（会话列表/聊天窗/气泡/已读/在线/附件 6 大界面重写 + socket 接入 + 原生打包调试） | **0.5-1 人日**（改 manifest start_url/scope → /im + 写 sw.js 离线壳，零打包） |
| 维护成本 | 低：单一 Web 代码库，壳层几乎不迭代 | 高：**双代码库**（Web 一套、RN 一套），每改一个 IM 功能要同步两处 | 最低：仍是 Web 一套代码 |
| 体验 | 中上：IM 专页本身是成熟 Web UI，手感略逊原生但可用；WebView 内推送受限 | 最好：原生滚动/手势/启动速度；离线推送可接原生 SDK | 中：iOS 主屏安装体验接近 App；**国产安卓浏览器（微信内置/部分厂商浏览器）无法安装、体验差** |
| Android 分发 | ✅ 顺畅：自签 APK 直发（沿用 owner 现有 D:/pi-mobile-app 渠道先例，服务器上只需产出 APK 供下载） | ✅ 同 A：Expo EAS Build 或本地 Gradle 出 APK 自签直发 | ⚠️ 非"App"：Chrome/Edge 可安装，微信内不可用，无 APK 实体 |
| iOS 分发难度 | ⚠️ IPA 签名需付费开发者账号；否则 iOS 走 WebClip 兜底（见下） | ⚠️ 同 A：EAS Build 出 IPA 同样需账号；真机调试需 Mac/Xcode 或云构建 | ✅ **零成本唯一正解**：Safari 添加到主屏即装，无需任何账号 |
| 离线推送 | 可接厂商/极光 SDK 于壳层（与 B 同等工作量） | 原生 SDK 接入最顺畅 | iOS 16.4+ Web Push 可用；**国内安卓基本不可用** |
| 推荐场景 | 快上线、团队小、IM 功能已成熟 | 长期战略产品、预算充足、重体验 | iOS 兜底、零成本快速覆盖 |

### 各方案 iOS 路径的现实选项

| iOS 路径 | 需要什么 | 成本 | 适用方案 | 现实性 |
| --- | --- | --- | --- | --- |
| **PWA/WebClip 添加到主屏** | 无任何账号 | ¥0 | C 直接受益；A/B 的 iOS 兜底 | ✅ 立即可做，唯一零成本真机路径 |
| 免费 Apple ID + Xcode 自签 | 一台 Mac + Apple ID | ¥0 但 7 天过期重签 | A/B 仅开发自测 | ⚠️ 不适合全员分发 |
| **开发者账号 + TestFlight** | $99/年 个人/公司账号 | ¥700/年 | A/B 正式路径 | ✅ 内部 100 测试员（外部 10000），无需上架 |
| 开发者账号 + AdHoc | 同上 | ¥700/年 | A/B | ✅ 100 台设备/年硬上限，超员需 TestFlight |
| 企业开发者计划 | $299/年 + D-U-N-S 企业资质 | ¥2100/年 | A/B | ⚠️ 仅限公司内部员工，Apple 严查滥用有吊销风险 |
| App Store 上架 | 账号 + ICP 备案 + 审核 | 账号费 + 数周审核 | A/B | ⚠️ 国内 IM 类目审核/合规成本高，内部工具不建议 |

**结论性建议（待 owner 拍板）**：Android 走方案 A（APK 自签直发）；iOS 无账号阶段走方案 C WebClip 兜底，员工数值得时再注册 $99 账号补 TestFlight 版。

## 二、架构章节

### 2.1 im-server 复用 vs 独立部署（推荐：全量复用）

| | 复用 im-server + 共享 PG（推荐） | 独立部署第二套 IM |
| --- | --- | --- |
| 消息同步 | **天然同步**：App 与 PM 网页读写同一批表（Conversation/ConversationMember/Message），同 socket 广播，零同步机制 | 需自建双向同步管道（队列/定时对账/冲突消解），复杂度高一个数量级 |
| 数据一致性 | 单源真相，无脑一致 | 双源漂移风险（消息丢失/乱序/对账遗漏） |
| 工作量 | 0（后端零改动） | 新增独立库 + 同步服务 + 运维监控，1-2 周+ |
| 前提条件 | 员工手机能访问 pm.hezongji.cn（现公网域名已代理 `/socket.io/`→:3002、REST→:3001，**已满足**） | 无 |
| 风险 | 单点：im-server 挂了 PM 网页 IM 与 App 一起挂（现状即如此，已稳定运行） | 同单点风险，还叠加同步失败风险 |

**裁决**：全量复用。独立部署在本需求下没有任何收益，只有成本。im-server 是独立进程、独立端口、独立鉴权（JWT），"分离出 IM"在服务端**已经完成**，缺的只是客户端壳。

### 2.2 认证方案（App 登录态与 PM 账号体系打通）

- 原则：**不建第二套账号**。App 登录 = 调 PM 现有 `POST /api/auth/login`（账号支持邮箱/用户名/姓名，密码 bcrypt，5 次失败锁 15 分钟已有），拿到 `{user, token}`（JWT HS256，30 天过期，载荷 `{userId, email, role, name}`）。
- 三路线落地方式：
  - **A WebView**：零开发——直接复用 PM 网页登录页，token 落 localStorage，SocketProvider 逻辑原样生效。
  - **B RN**：原生登录页 → 调同一 login API → token 存 SecureStore（RN 安全存储）→ `socket.io-client` 以 `auth:{token}` 握手、REST 请求带 Bearer。30 天过期 → 401 拦截回登录页。
  - **C PWA**：同 A，网页登录零改造。
- 密钥契约：im-server 与主服务共享 `JWT_SECRET`（现机制），App 端不持有任何密钥，只持 token。**禁把 JWT_SECRET 打包进客户端**。

### 2.3 离线推送方案对比

| 方案 | 覆盖 | 前置条件 | 工作量 | 成本 | 推荐度 |
| --- | --- | --- | --- | --- | --- |
| **无推送，打开补拉**（现状机制） | App 打开时 socket 实时 + `GET /api/conversations` 聚合未读 | 无 | 0（已存在） | ¥0 | ✅ 首期必选兜底：1 周内上线 |
| 极光 JPush / 个推 Getui 聚合 SDK | 厂商通道（华为/小米/OPPO/vivo）+ iOS APNs 一家 SDK 通吃 | 企业资质注册（普通企业即可，非厂商级开发者资质）+ iOS 仍需开发者账号 | 3-5 人日（服务端集成 + 壳/RN 集成 + 厂商后台配置） | 免费额度（内部小规模够用） | ✅ 二期推荐：性价比最高 |
| 厂商通道自建（华为 HMS/小米/OPPO/vivo 逐一接入） | 每家厂商独立企业开发者资质 + 独立集成 | 4-5 家通道 + im-server 侧 push 路由，10+ 人日 | 部分通道年费/保证金 | ⚠️ 员工机型杂时覆盖难，除非公司统一采购手机 |
| iOS APNs | 苹果开发者账号 + APNs 证书 | 1-2 人日 | 含在 $99 账号内 | 有账号后再做 |

**推送与合规**：极光/个推属持牌第三方，接入即合规；自建厂商通道需逐家资质；无推送方案零合规成本。国内安卓杀后台是常态，**任何方案都无法保证 100% 到达，未读补拉是永久兜底**。

### 2.4 IM 专页路由设计（从 PM 前端抽出 /im 独立入口）

目标：独立 App 打开的是**纯 IM 界面**，不带 PM 管理系统的侧边栏/工作台。

**改造点清单**（对 PM 前端，均为增量、不动现有 /messages）：

| # | 改造点 | 说明 | 工作量 |
| --- | --- | --- | --- |
| 1 | 新路由 `/im` | 渲染现有 messages 页组件，但挂独立 layout（去掉 (main) 侧边栏/顶栏，纯聊天壳） | 0.5 天 |
| 2 | manifest 独立 scope | 新建 `/im/manifest.json` + `/im/sw.js`（start_url=/im，scope=/im），与主站 PWA 互不干扰；现主站 sw.js 是自卸载桩，需为 /im 重写一个带缓存/推送注册的真 sw | 0.5 天 |
| 3 | 登录守卫 | `/im` 未登录 → 重定向 `/login?next=/im`（复用现有 auth-store 与 PageGuard，改参数即可） | 0.1 天 |
| 4 | 桌面通知 | 复用现有 `lib/notify`（WebView/PWA 生效；RN 路线需原生桥接重写，计入 B 的开发量） | 0（A/C） |
| 5 | WS 地址 | 沿用 `NEXT_PUBLIC_WS_URL`（生产 wss 经 nginx 反代，已通）；App 壳内允许 http 明文 ws 的例外配置（Capacitor 需 allowNavigation/cleartext 白名单） | 0.2 天 |
| 6 | 可选独立域名 | nginx 已有 `im.hezongji.cn`（现指向 :8080），改指 `/im` 路由或直接复用 pm.hezongji.cn/im | 0.1 天 |

**要点**：/messages 与 /im 共享同一批组件与 store（zustand chat store / react-query），消息数据零分叉；SocketProvider 挂在 /im 布局下即可复用全局未读与桌面通知逻辑。

### 2.5 接口契约（复用现有，无新增后端）

| 契约 | 现状 | App 使用 |
| --- | --- | --- |
| `POST /api/auth/login` | `{email,password}` → `{user, token}` | 三路线登录入口 |
| `GET /api/conversations` | 会话列表含 unread/lastMessage/members | 会话列表 + 未读补拉 |
| `GET /api/conversations/:id/messages?before=&limit=` | 历史消息游标分页（成员校验 403） | 聊天窗 |
| `POST /api/conversations/:id/read` | 已读标记（NOTIFY 广播 read:sync） | 进会话自动标读 |
| `Socket.IO ws://…:3002?token=<JWT>` | 握手鉴权 + message:send/new/revoke、read:sync、presence:sync、typing、conv:created、notify:push、todo:push | 实时链路，三路线同一协议 |
| 文件消息 | fileMeta 引用主服务 /api/files 记录 | 复用现 REST 上传 |

## 三、边界与约束

- 后端零改动（im-server/主服务 API/PG schema 全部复用）；本变更唯一新增面 = 客户端与 /im 专页
- 认证沿用 PM 账号体系与 JWT 契约；客户端永不含 JWT_SECRET
- 消息一致性由共享 PG 单源保证；不做任何缓存同步层
- 首期性能预算：与 PM 网页同规格（无新增压力；App 在线即一条 socket 连接）

## 四、风险清单（评审重点）

- [ ] iOS 无账号 → 方案 A/B 的 iOS 真机分发被卡死；须以 C 兜底并尽早让 owner 定 iOS 预算
- [ ] 国产安卓杀后台 → 离线消息收不到；缓解 = 二期接极光 + 打开补拉兜底
- [ ] WebView 壳内通知权限/文件上传与浏览器行为差异（Capacitor 需白名单与权限桥）
- [ ] 员工手机无法访问 pm.hezongji.cn 公网域名（内网办公场景需确认外网可达或配内网 DNS）
- [ ] RN 双代码库漂移：Web 与 RN 功能不同步（若选 B，须把"功能变更同步两库"写进后续 DoD）
- [ ] PWA 在国产安卓浏览器（微信内置）不可安装，安卓员工必须用 Chrome/Edge 或 APK
- [ ] 30 天 token 过期体验（可后续加 refresh 机制，非本变更范围）

## 五、冲突与消解

- **PWA 主站 sw.js 是自卸载桩**（历史修复产物）→ /im 用独立 scope 的 sw.js，不复活主站缓存策略，避免重蹈部署缓存坑（见 pm-deploy 知识库）
- **manifest 全站仅一份** → 新增 /im 专属 manifest，主站 manifest 不动
- **im.hezongji.cn 域名已被占用**（指向 :8080）→ 复用 pm.hezongji.cn/im 即可，不动既有域名配置；确需独立域名时再评估 :8080 服务
- **WebView 壳与 PM 网页共用登录态** → 首期接受（同员工同账号）；若后续要求 App 独立登录态，RN 路线天然隔离

## owner 确认关口（S2 闸门）

| # | 决策点 | 选项 A | 选项 B | 选项 C | 推荐 | owner 拍板 |
| - | ------ | ------ | ------ | ------ | ---- | ---------- |
| 1 | **技术路线** | WebView 壳（1-3 天） | RN+Expo 真 App（2-4 周） | PWA（0.5-1 天） | **A+C 组合**：Android 壳 + iOS PWA | ✅ **方案 A**（2026-08-29 拍板） |
| 2 | **iOS 策略** | 注册 $99/年 开发者账号（TestFlight 分发） | 零成本 PWA/WebClip 兜底 | 暂缓 iOS，只发 Android | 先 B 后视员工占比升级 A | ✅ **放弃 iOS，只发 Android APK**（2026-08-29 拍板；spec 内 iOS 相关方案全部作废） |
| 3 | **推送方案** | 极光/个推聚合 SDK（3-5 人日，二期） | 厂商通道逐一自建（10+ 人日） | 无推送，打开补拉 | **先 C 后 A** | ✅ **先 C 后 A**：一期无推送（打开补拉），二期极光（2026-08-29 拍板） |
| 4 | 前置数据 | 请提供员工手机安卓/iOS 占比（或授权问卷） | — | — | 影响 iOS 预算决策 | ~~作废~~：随 iOS 放弃，Android-only 无需机型占比 |
| 5 | **分发方式**（owner 追加） | — | — | — | APK 放 PM 系统扫码下载 | ✅ **APK 放 PM 系统 + 二维码下载页**（/public/downloads/，nginx 配 .apk MIME，链接走 https://pm.hezongji.cn） |

## 版本依据

- 复用现库现协议，无新库引入（Capacitor/Expo 版本在 S3 立项时再查 context7 定版，防版本漂移）
- socket.io 服务端 4.8.3 / 客户端 4.7.2 已在线验证；RN 端 socket.io-client 同系兼容

## 验收断言（S4 逐项验证，本变更仅到 S2，断言为后续阶段预埋）

- [ ] App 登录成功后可实时收发消息，且 PM 网页 /messages 同会话 2s 内可见
- [ ] App 断线重连后会话订阅恢复、未读聚合正确（复用 im-server test-e2e.js 场景）
- [ ] /im 专页无 PM 侧边栏，未登录重定向 /login 正常
- [ ] PM 网页 IM 零回归（跑现有 IM 链 e2e）
- [ ] Android APK 在真机安装运行；~~iOS 验收~~（已放弃 iOS，2026-08-29 拍板）

## 环境差异清单

- 打包在服务器 Linux 出 APK（Gradle/Expo 云构建）；iOS 构建必须 Mac 或 EAS 云构建（无 Mac 时用云构建，需账号）
- 生产 WS 走 nginx wss（pm.hezongji.cn /socket.io/ 已配置），App 壳需允许混合内容/明文 ws 白名单（本地测试场景）
- 已知坑沿用 pm-deploy 知识库（前端空白/部署缓存等主站教训，不在此重复踩）

---
> 闸门：owner 已拍板上表全部决策点（2026-08-29，含追加的分发方式）→ commit = approved，触发 S3。S3 闸门：plan.md 经 v4-pro 架构审 + owner 审阅通过后方可进入 S4。
