# test-report · 网盘化改造战役（20260830-drive-war）

> S4 测试收口 ｜ 执行: 第二任 SDLC 指挥官 ｜ 环境: 本机 3101 测试服务器（同一生产 DB）+ 生产 pm.hezongji.cn
> 结论: **全绿 GO**（45/45 主链 + 13/13 move 回归 + 9/9 IM 回归 + 生产复验 45/45）

## 一、数据层验证（W1）

| 项 | 结果 |
|---|---|
| 迁移 DDL（FolderKind/path/软删列/folderId/枚举扩展） | ✅ prisma migrate deploy 成功，PG16 无锁风险 |
| 回填 M2 kind（phaseCode→SYSTEM） | ✅ 1211 目录 |
| 回填 M2 path 物化 | ✅ 1213→全量，空 path=0 |
| 回填 M3 收拢「00-交付计划」 | ✅ 64 组创建，1211 阶段目录改挂（catalogId 不变，引用零破坏） |
| 回填 M4 folderId（storagePath 前缀解析） | ✅ 1640/1640，路径 1 兜底 0、路径 2 兜底 0、孤儿 0 |
| **抽样一致率** | ✅ **100.00%（1640/1640）** |
| 幂等性重跑 | ✅ 第二次执行 0 行更新 |

## 二、功能全链（W5 verify，45 断言）

**Phase A ADMIN 全链**（23 项全绿）：建目录（根/嵌套/path 维护/同级重名拒绝）→ 上传（folderId）→ **同名自动合并 v2/v3（D4）** → 合并列表单行最新版 → 重命名（全家版本同步）→ **移动 DB-only（folderId 变更 + storagePath 不变的物理解耦证明）** → 版本列表 3 行 → 软删→回收站→恢复 → **目录整树软删（2 目录+3 版本）→树消失→回收站→整树恢复** → 批量下载 zip（PK 头/流式）→ 全局搜索命中 → SYSTEM 目录删/改名 403（ADMIN 也禁）→ MANAGER+ 应急通道（SYSTEM 下建目录/传文件 ✓）

**Phase B 权限矩阵**（12 项全绿）：
- MEMBER 建目录 ✓ / 上传自由文件 ✓（intent C1 用户目录自由）
- MEMBER 在 SYSTEM 传自由文件 ✗ / 建目录 ✗ / 改 SYSTEM 目录名 ✗
- MEMBER 删目录 ✗（delete 留 MANAGER+）/ 删自己上传的文件 ✓ / 恢复自己文件 ✓ / 彻底删除 ✗
- **非成员：drive/list 403 + catalogs 403 + 上传 403（owner 底线「仅项目成员可见和下载」达成）**

**Phase C 回归**（6 项全绿）：交付计划条目 API 原样 ✓ / 旧 catalogId 上传兼容（IM/聊天链路）✓ / 旧 catalogId 移动兼容（IM App）✓ / SYSTEM 目录列表混排条目行 ✓ / isSystemFolder 标记 ✓

## 三、回归套件

| 套件 | 结果 | 说明 |
|---|---|---|
| w4-file-move-test | ✅ 13/13 | 断言已按新契约更新（storagePath 不变+folderId 权威），语义变更依据 spec §3.9（owner 拍板 D1-D7 已授权） |
| verify-im-app（生产） | ✅ 9/9 | IM 无回归（socket/APK/页面） |
| type-check / lint / build | ✅ | 0 error |
| 回收站 purge 链路 | ✅ 实测 | 篡改 deletedAt=40 天前 → 脚本清除 → DB 行 0 残留 + 磁盘文件已删 |
| drive-purge-recycle --dry-run | ✅ | 正常输出 |

## 四、生产部署验证（S5）

- 深夜窗口 01:25 systemctl restart pm-app（<10s 中断）
- **生产复验 drive-war-verify：45/45 全绿**（经 nginx→pm-app 全链）
- verify-im-app 生产 9/9；/files 200；journalctl 无 error
- 部署纪律遵守：迁移前 backup-pm.sh（dump 752K+uploads 13M 校验通过）；仅动 pm.hezongji.cn

## 五、过程中发现并修复的缺陷

1. **webpack 改写 require 事故**：archiver CJS callable 经 webpack 打包变命名空间对象（"s is not a function"）→ 改 `createRequire`（无法被静态分析）+ archiver@7（v8 纯 ESM 弃用）+ serverExternalPackages
2. **版本家族拆家 bug**：重命名/移动/软删只作用于最新版本行 → 旧版本「浮出」或家族拆散 → 统一家族语义（folderId+originalName 整组操作），含恢复/清除
3. **/api/files 列表前缀耦合**：仍按 storagePath 前缀过滤会漏移入/误含移出 → 改 folderId 权威 + 软删过滤
4. **purge 脚本 FK 违规**：FileAccessLog.userId='system' 违反外键 → 改用真实 ADMIN id 审计
5. **备份脚本顺序 bug**（战役纪律前置检查发现）：chmod SHA256SUMS 在生成前执行致脚本中断 → 修复顺序（本次战役备份核心数据完好验证后继续）

## 六、待 owner 次日确认清单（保守项，不阻塞）

1. **目录删除权限口径**：当前 MEMBER 可删自己上传的文件，但**删文件夹（整树）需 MANAGER+**（spec §3.2 映射 delete 级）。若希望"建夹人可删自己的夹"需加 createdBy 列（一期 schema 未含，二期可加）
2. **「00-交付计划」组**：交付计划 Tab 树现为 根→00-交付计划→20 阶段目录（深一层），D2 已拍板收拢；不习惯可改前端默认展开
3. **移动端真机验收**：响应式（lg 断点树收下拉/按钮化操作）已按 WebView 能力实现，真机体验待 owner 手机验证
4. 回收站保留期 30 天（D3），DRIVE_RECYCLE_RETAIN_DAYS 可调

## 七、遗留风险

- 搜索 ILIKE 无索引（当前 1640 文件量足够；>10 万级再上全文索引，二期）
- 目录树一期全量建树（单项目目录 <百级实测无压力；二期懒加载）
- batch zip 内存：archiver 流式输出不整包进内存，单批限 100 文件
