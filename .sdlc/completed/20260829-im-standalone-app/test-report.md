# Test Report: PM-IM 独立聊天 App（S4 验证）

- **Change-ID**: 20260829-im-standalone-app · **阶段**: S4 · **日期**: 2026-08-29
- **验证结论**: 全链自动化验证 9/9 PASS + IM 链 e2e 13/13 PASS + 手机视口 UI 走查无问题；**真机安装验收 owner GO（2026-08-29 v1.6.0 终验：最终软件验证没问题，语音功能和交流聊天功能都正常了）**

## 验证记录

### W1 · /im 专页（已上线 https://pm.hezongji.cn/im）
| 验证项 | 方法 | 结果 |
| ------ | ---- | ---- |
| 类型/语法 | `tsc --noEmit` + `eslint` | ✅ 0 error（12 warning 均为既有代码模式） |
| 生产构建 | `npm run build` | ✅ Compiled，/im 静态页进入路由表 |
| IM 链零回归 | `scripts/qa/b2-im-notify-chain.mjs`（打新构建） | ✅ 13/13 PASS |
| 手机视口渲染（评审 I1 硬性要求） | playwright-core headless 390×844 + 登录态注入 | ✅ 7/7：无侧边栏/无顶栏/会话列表渲染/未跳登录 |
| 手机视口截图走查 | glm-5.3-flash 读图 | ✅ 无溢出/错位/重叠 |
| 桌面 /messages 零回归 | headless 1440×900 截图走查 | ✅ 侧边栏+双栏布局正常 |

### W2 · Android 壳工程（mobile-app/）
| 验证项 | 结果 |
| ------ | ---- |
| assembleDebug | ✅ BUILD SUCCESSFUL |
| assembleRelease + 签名 | ✅ v2+v3 验证通过，APK 4.5M |
| 需求点对照（11 项：UA/JS桥/文件选择/DownloadManager/双击退出/重试页/外链/mixedContent/splash/mipmap） | ✅ 全部实现（见 worker 报告） |
| adb 装机 | ⏭️ 无设备，待 owner 真机验收 |

### W3 · 打包脚本 + 分发链
| 验证项 | 结果 |
| ------ | ---- |
| build-apk.sh 可重复执行（keystore 复用） | ✅ 二次运行 SHA-256 一致 |
| keystore 异地备份 | ✅ /root/pm-backup/pmchat.jks（密码 pmchat2026，建议转存密码管理器并再备份一份至异机） |
| nginx /downloads/ 直出 | ✅ 404→200（修复了 sites-enabled 普通文件副本未同步的坑） |

### W4 · 下载页（https://pm.hezongji.cn/download）
| 验证项 | 结果 |
| ------ | ---- |
| 页面 200 + 不强制登录 | ✅ |
| APK 直链 MIME/大小 | ✅ application/vnd.android.package-archive / 4.41MB |
| SHA-256 回填 | ✅ 7778c0d2…2d87 |

### W5 · 全链验证（scripts/verify-im-app.mjs）
✅ **9/9 PASS**：下载页 / APK MIME / APK 大小 / /im / /login?next / socket 无 token 拒连(unauthorized) / socket 带 token 连接成功

## 重大发现与修复（超出计划）

**FIX-WSURL · PM 网页 IM 实时功能此前实际断连**：
- `NEXT_PUBLIC_WS_URL=https://pm.hezongji.cn/api/im-socket` 的路径名被 socket.io-client 当作 namespace（im-server 仅有默认 '/'）→ 握手返回 `Invalid namespace`，页面双 socket 连接全部失败，员工只能靠刷新 REST 拉取消息
- QA 脚本用 origin 路径测试所以从未暴露
- 修复：.env 改 `NEXT_PUBLIC_WS_URL=https://pm.hezongji.cn`（默认 /socket.io 通道，nginx 已有 location）→ 重新构建部署 → headless 捕获 websocket 帧确认双连接 `40{"sid":…}` + `42["connected"]` ✅
- 影响：本战役之外，PM 网页 IM 实时功能同步修复

## 遗留风险（真机验收关注点）

1. 自签 APK：Play Protect「风险应用」提示（下载页已写「仍要安装」指引，固有现象）
2. 微信内打开下载链接会被拦截（下载页已提示换系统浏览器）
3. 附件下载 JS 桥 / 文件选择器：仅代码实现+编译验证，真机行为待验
4. 卡片消息跳转完整 PM 页面：评审 N4 一期接受
5. Android 版本兼容：minSdk 24 覆盖 Android 7.0+，主流机型无虞但未实测

---
> 闸门：自动化验证全绿 → 进入 S5。**GO/NO-GO 由 owner 真机扫码验收决定**。
