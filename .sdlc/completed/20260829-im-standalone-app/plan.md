# Plan: PM-IM 独立聊天 App（Android WebView 壳 + PM 扫码下载）

- **Change-ID**: 20260829-im-standalone-app · **阶段**: S3 · **状态**: 修订版 v2（已落实 v4-pro 架构审 I1-I5 修法，待 owner 审阅）
- **依据**: intent.md + spec.md（owner 拍板 2026-08-29：方案 A / Android-only / 一期无推送 / APK 放 PM 扫码下载）

## 现场侦察结论（2026-08-29）

| 项 | 现状 | 结论 |
| -- | ---- | ---- |
| 登录态 | login 页写 `localStorage['auth-token']`（JWT 30 天）+ zustand persist；AuthGuard 检查 localStorage | WebView 同域内 localStorage 自动持久化 → **登录态零改造打通** |
| IM 前端 | `src/app/(main)/messages/page.tsx`（913 行），挂 (main) layout（Sidebar/Header/AuthGuard） | 需新建 /im 轻布局路由复用聊天核心 |
| IM 后端 | im-server :3002 稳定（F-005~F-008 已修），生产 nginx `/socket.io/` → im:3002 已通 | **不动 im-server** |
| 打包环境 | 本机已有 OpenJDK 17 + keytool + /opt/android-sdk（platforms/android-34, build-tools/34.0.0, cmdline-tools, platform-tools）+ /opt/gradle.zip | **本机可直接出 APK，无需云构建** |
| PWA | manifest.json standalone 已有；sw.js 为自卸载桩 | 无改动需求（Android-only） |
| 分发 | Next.js public/ 静态目录 + nginx（deploy/nginx.conf） | APK 放 public/downloads/，下载页生成二维码 |

## 工程分解（W1-W5，预计 2-3 人日）

### W1 · IM 专页路由（PM 前端，约 1 天）
**改哪些文件**：
- `src/app/im/layout.tsx`（新建）：极简布局 = AuthGuard + 全屏无侧边栏容器；无 Header/Sidebar/AssistantPanel
- `src/app/im/page.tsx`（新建）：渲染共享组件 `MessagesPageInner`
- **抽共享组件为主选**（v4-pro I1）：messages/page.tsx 是桌面固定双栏（列表 `w-72` + 聊天 `flex-1`，`h-[calc(100vh-8rem)]`，无任何移动端断点），手机 WebView 下不可用。抽出 `MessagesPageInner` 加移动端单栏模式（列表↔聊天切换态，`flex-col md:flex-row`），高度改 `h-dvh` 由布局提供；/messages 与 /im 共用，PM 网页零回归
- **token 过期闭环（v4-pro I3，约 20 行四处小改）**：
  1. `auth-guard.tsx` 跳 `/login?next=/im`；2. `login/page.tsx` 读 `?next` 参数回跳（替换硬编码 `router.push('/')`）；3. `api.ts` 401 跳转携带当前路径；4. /im 变体加 `socket.on('connect_error')` → unauthorized 时跳 `/login?next=/im`（防 token 失效后 socket 假死无提示）
**证明测试**：手机视口冒烟（~400dp 宽度下列表↔聊天切换、发消息、网页 /messages 2s 内可见）+ 现有 IM 链 e2e 零回归 + token 过期/清 localStorage 后正确回跳 /login?next=/im 重登回 /im

### W2 · Android WebView 壳工程（约 1.5 天）
**改哪些文件**：新建 `mobile-app/`（Kotlin 原生壳，不引入 Capacitor/RN，零第三方依赖）
- `MainActivity` + WebView：
  - 加载 `https://pm.hezongji.cn/im`；`setDomStorageEnabled(true)`（localStorage 登录态持久化）；自定义 UA 后缀 `PMChat/1.0`
  - **附件下载 JS 桥（v4-pro I2，必做，60-80 行）**：Web 层附件走 blob 锚点下载，WebView 不触发 DownloadListener（点下载会静默无反应）。壳内注入脚本 hook blob 锚点点击 → FileReader 转 base64 → `@JavascriptInterface` → 原生落盘（MediaStore/Downloads）
  - **下载通知（v4-pro I5）**：用 DownloadManager `VISIBILITY_VISIBLE_NOTIFY_COMPLETED`（系统进程通知，不受 Android 13+ POST_NOTIFICATIONS 权限约束），不自建 NotificationCompat
  - `onShowFileChooser`（聊天发图/发文件）；外链用系统浏览器打开
  - 后退键 = WebView 历史后退，到底双击退出（防误触）；`onReceivedError` 友好重试页（弱网冷启动不白屏）
  - `adjustResize` 键盘适配；首帧 splash；图标 mipmap 多密度（复用 icon-192x192.png 生成）；应用名「PM 聊天」
  - `mixedContentMode=MIXED_CONTENT_NEVER_ALLOW` + 不开 cleartext（生产 WS_URL 同源 https，无明文需求）
- targetSdk 34 / minSdk 24（Android 7.0+，覆盖主流员工机）
**证明测试**：`gradle assembleDebug` 编译通过 + 冒烟清单（登录、发消息、**传图、下载附件**）

### W3 · APK 签名打包脚本（0.25 天）
- `scripts/build-apk.sh`：keytool 生成自签 keystore（首次）→ assembleRelease → apksigner 签名 → 产出 release APK
- **APK 不走 Next public（v4-pro I4，必改）**：public/ 烤在 docker 镜像里（Dockerfile COPY + 无卷挂载），写宿主机 public 容器看不见。改为：`deploy/docker-compose.yml` 加 bind mount `./deploy/downloads:/data/downloads:ro` + `deploy/nginx.conf` 加 `location ^~ /downloads/ { alias /data/downloads/; default_type application/vnd.android.package-archive; }` → 发 APK 零重启零回归
- **gitignore 两个陷阱（v4-pro I4）**：① `.gitignore` 有 `*.sh` → 加 `!scripts/build-apk.sh` 例外；② 加 `mobile-app/*.jks` 防误提交
- **keystore 异地备份（v4-pro I4）**：keystore 丢失 = 签名变更 = 全员卸载重装丢登录态，W3 交付物必须含 keystore 异地备份（备份位置 + 恢复步骤写进 README）
- versionCode/versionName 进 `mobile-app/app/build.gradle`，后续发版递增
**证明测试**：脚本全绿产出 release APK + `apksigner verify` 通过 + `adb install` 成功

### W4 · PM 下载页 + 二维码（0.5 天）
- `src/app/download/page.tsx`（新建，轻页面，**不强制登录**，扫码即达）：
  - 二维码（内容 = `https://pm.hezongji.cn/downloads/pm-chat-<version>.apk`）；引入 `qrcode` npm 包（纯 JS 轻量，唯一新前端依赖）
  - 安装指引：允许「安装未知应用」、Play Protect 提示「仍要安装」、微信内打开需换系统浏览器
  - **展示 SHA-256 校验值 + 版本号**（防仿冒 APK 转发，v4-pro N5）+ 页面 noindex
- `next.config.js` headers 无需改（APK 改由 nginx 直出，见 W3）
- `deploy/nginx.conf`：`/downloads/` location（与 W3 合并为同一改动）
- PM 内入口：帮助页加「移动端聊天 App」下载链接
**证明测试**：curl 下载页 200 + APK 响应头 MIME 正确 + 二维码解码后 URL 可下载

### W5 · 验证（0.5 天）
- `scripts/verify-im-app.mjs`：全链断言，**范式照抄 scripts/qa/b2-im-notify-chain.mjs**（v4-pro N1）：
  - 下载页 200 → APK MIME → token→`GET /api/conversations`（AuthGuard 是客户端守卫，GET /im 未登录也返 200 HTML，无效断言）→ socket 握手 → 发消息网页端 <2s 可见 → 网页发消息 /im 可见
  - **补 intent 成功标准逐条**：未读计数、已读回执（read:sync）、在线状态（presence:sync）、历史分页、「<2s」时延断言
- 前端验证沿用现有 .mjs 脚本模式（仓库无 playwright，不新增装机体，v4-pro N2）；手机视口适配由代码评审 + 真机冒烟清单覆盖
- 真机验收清单交 owner（S5 GO/NO-GO）

## 工作顺序与依赖

W1（/im 页）→ W2（壳，依赖 /im 可访问）→ W3（打包，依赖 W2）→ W4（下载页，可与 W2/W3 并行）→ W5（全链验证）
**并行度**：W1 完成后，W2+W3 与 W4 可分两个子代理并行（worktree 隔离：W2/W3 动 mobile-app/ + scripts/；W4 动 src/app/download + deploy/nginx.conf + docker-compose）

## 评审遗留决策（v4-pro N3/N4，默认接受，owner 可否决）

- **权限一致性（N3）**：PageGuard 随复用带进 /im——管理员若取消某用户「消息」权限，其聊天 App 即无权限。定为**期望行为**（与 PM 权限一致），不再单独设 App 权限。
- **卡片消息跳转（N4）**：消息卡片（项目/任务卡）点击 `router.push('/projects/...')` 会在壳内打开完整 PM 页面。一期**接受**（保持登录态，体验可接受），二期评估拦截转系统浏览器。

## 风险清单

| # | 风险 | 影响 | 缓解 |
| - | ---- | ---- | ---- |
| 1 | messages 页桌面双栏无移动端适配（I1） | 手机 WebView 不可用 | 抽共享组件加单栏模式 + 手机视口冒烟（已入 W1） |
| 2 | 附件 blob 下载在 WebView 静默失效（I2） | 点下载无反应 | JS 桥 + FileReader + 原生落盘（已入 W2，必做） |
| 3 | token 30 天过期：socket 假死/落地错页（I3） | App 假死或落到整个 PM 工作台 | ?next 闭环四处小改（已入 W1） |
| 4 | public/ 烤进镜像，APK 落地不生效（I4） | 每次发 APK 需重建镜像重启 | nginx bind mount + alias 直出（已入 W3/W4） |
| 5 | `*.sh` 被 gitignore 吞脚本；keystore 丢失不可升级（I4） | 交付物失联/全员重装 | gitignore 例外 + keystore 异地备份（已入 W3） |
| 6 | Android 13+ 通知权限静默吞通知（I5） | 下载成功用户无感知 | DownloadManager 系统通知（已入 W2） |
| 7 | 自签 APK 被 Play Protect 警告 | 员工安装有顾虑 | 下载页写清「仍要安装」指引（自签分发固有，无法消除） |
| 8 | 微信内置浏览器拦截 APK 下载 | 扫码下载失败 | 下载页醒目提示换系统浏览器扫码 |
| 9 | Gradle 首次构建联网拉依赖失败 | 打包卡住 | /opt/gradle.zip 本地有；maven central 可达性开工即验证 |
| 10 | 一期无推送，App 后台收不到实时消息 | 体验打折 | socket.io 自带重连 + 打开补拉（已拍板接受，二期极光） |

## 版本依据
- android-34 + build-tools 34.0.0 + OpenJDK 17（本机已有，不动 SDK 版本）
- 前端仅新增 `qrcode` 依赖；不引入 Capacitor/RN/Expo

---
> 闸门：v4-pro 架构审已通过（有条件，I1-I5 修法已全部落入本版 v2）+ owner 审阅通过 → commit = approved，触发 S4 Build。
