# S2 设计方案 · 项目网盘化改造（spec.md）

> change-id: 20260830-drive-war ｜ 2026-08-30 ｜ 状态: **✅ owner 已拍板放行（2026-08-30 全权授权）**
> 拍板结果: D1-D7 全部按推荐生效；授权边界见 HANDOFF.md（仅 pm.hezongji.cn / 避峰部署 / DB 迁移前 backup-pm.sh / free<1200M 暂停 / 一期 MVP 优先）
> 侦察基线：prisma schema (FileCatalog/FileRequirement/File/FileAccessLog/ResourcePermission) + /api/files* + /api/projects/[id]/catalogs + /lib/permission.ts (811行三层引擎) + /lib/file-storage.ts + /files 页面

---

## 1. 现状侦察结论（设计的地基）

| 模块 | 现状 | 对网盘的意义 |
|------|------|--------------|
| FileCatalog | 已是无限层级树（parentId 自关联+环检测+order），但由流程引擎按模板自动生成 20 个「NN-阶段名」根级目录；删除需空目录 | ★ 目录树模型基本够用，缺「系统/用户目录」区分与自由删改 |
| FileRequirement | 交付计划条目（owner/审批人/scope/dueDate/状态机/归档拦截），强挂 catalogId | 审批流核心，不能动；网盘视图需把它显示为「带状态徽章的特殊行」 |
| File | **无目录列**，靠 storagePath 前缀 `{projectId}/{catalogId}/{uuid}.ext` 定位；requirementId 可空=计划外临时文件；version 同条目递增 | ★ 最大耦合点：补 folderId 显式外键 + 回填 |
| FileAccessLog | 7 种动作（VIEW/DOWNLOAD/UPLOAD/APPROVE/REJECT/OBSOLETE/MOVE），fileId 删除后 SetNull 保留审计 | 审计骨架已在，补网盘动作枚举即可 |
| ResourcePermission | ResType 已含 FILE_FOLDER/FILE_REQ；PrincipalType 已含 **DEPARTMENT** | ★ 文件夹 ACL+部门继承的现成抓手，不建新表 |
| permission.ts | 三层合成：全局角色→项目角色基线(OWNER/MANAGER/MEMBER/VIEWER)→资源 ACL∪合并→FILE_REQ 范围终审；LRU 缓存 5min | 网盘权限=在此引擎上加 FILE_FOLDER 判定分支，不改架构 |
| file-storage.ts | 单文件默认 100MB、项目配额 10GB（env 可调）；storagePath 存相对路径；下载支持 Range 206 流式 | 上传/下载/配额链路直接复用 |
| /files 页 | 项目选择器+左树右表（RequirementTable 条目表） | 布局骨架复用，右侧换/加文件列表视图 |
| 无回收站 | 无任何软删除机制 | 新增 |

---

## 2. 共存策略（核心矛盾裁决）

### 三方案对比

| 维度 | A. 双轨制：交付计划+项目网盘两套独立模块 | **B. 融合制：一棵树，阶段目录=受保护系统文件夹 ★推荐** | C. 替代制：全新网盘模型，旧体系迁移映射 |
|------|------|------|------|
| 数据模型改动 | 新增 DriveFolder/DriveFile 全套模型 | FileCatalog 加 kind 枚举+软删；File 加 folderId；动作枚举扩展 | 全部重建+迁移 |
| 存量数据 | 零迁移但割裂（同一文件两个家） | 加列回填，**物理文件零搬迁** | 全量迁移（风险最大） |
| 用户体验 | 两个入口，用户需理解"放哪边" | **一个入口一棵树**：项目网盘里可见「01-交付计划」系统区+自建区 | 一步到位但过渡期长 |
| 权限/审批兼容 | 天然隔离但逻辑重复实现 | 三层引擎加分支，审批流零改动 | 全部重接 |
| 工期/风险 | 中/中 | **最小/低** | 最大/高 |

### 推荐方案 B「融合制」具体形态

1. **一棵树**：项目网盘 = 该项目的 FileCatalog 全树（项目为网盘根）。
2. **系统目录**：现有 20 个阶段目录标记 `kind=SYSTEM`（禁删/禁改名/禁移出，普通项目角色不可在其下建用户子目录——避免污染交付计划结构；MANAGER/OWNER 例外）。迁移时将其收拢到一个 `00-交付计划` 系统根组下（catalogId 不变，仅改 parentId，引用零破坏；见 §6）。
3. **用户目录**：`kind=USER`，项目成员（MEMBER 及以上）在根级或用户目录下自由创建/改名/移动/删除；系统目录内只读浏览+按现有条目流程上传。
4. **条目=特殊文件行**：网盘文件列表合并展示两类行——①自由文件（File, folderId 直挂）②交付条目（FileRequirement，显示为带状态徽章的"文件"行，点击进入现有详情抽屉）。同一张表，Windows 资源管理器式混排。
5. **物理/逻辑解耦**：File.folderId 变更（移动/上传）只改 DB，storagePath 物理路径不变，永不搬文件。

> 兜底：若 owner 担心融合后交付计划视图被"污染"，可将 /files 页拆成两个 Tab（「交付计划」=现有视图原样保留 /「项目网盘」=新视图），Tab 切换零成本——融合是模型层共识，视图层可再分。

---

## 3. 十一项设计清单逐项方案

### 3.1 目录树模型
- 复用 FileCatalog；新增 `kind: FolderKind(SYSTEM/USER)@default(USER)`、`deletedAt/deletedById`（软删）。
- 无限层级、移动/改名沿用现有环检测与校验；约束新增：SYSTEM 目录不可删/改名/移动，不可把目录移入自己子树（已有）；USER 目录删除=软删整棵子树（连带子目录内文件全部软删，进回收站）。
- 同级重名校验：同父目录下目录名唯一（大小写不敏感）；文件同级同名→触发版本合并（见 3.8）。

### 3.2 权限模型（组织架构继承 × 项目角色 × 三层引擎整合）
- **底线（owner 需求原文）**：仅项目成员可见和下载——由现有项目角色基线天然保证（非成员无 PROJECT.view → 整棵树不可见），零新代码。
- **文件夹 ACL 继承组织架构**：复用 ResourcePermission(FILE_FOLDER)，PrincipalType=DEPARTMENT 即部门授权；**继承算法 = 沿祖先链 ACL 并集（∪，只加不减，与现有引擎 ACL 语义完全一致）**，即"给部门 X 授权到父文件夹 → 其所有子文件夹生效"。LRU 缓存与 invalidateProject 失效机制直接沿用。
- **项目角色维度**：网盘动作映射现有 Action 集——建目录/上传=upload、改名/移动=edit、删入回收站=delete、恢复=delete、彻底删除/清空回收站=delete 且仅 MANAGER/OWNER、下载=download、浏览=view。判定公式：`folderPerm(user) = 项目角色基线(project) ∪ 祖先链ACL(FILE_FOLDER)`，再叠加 SYSTEM 目录只读限制。MANAGER/OWNER 可管理 SYSTEM 目录内结构（应急），MEMBER 只读。
- **外部主体（ExternalOrg/供应商）**：一期**不开放**（外链只读分享涉及免登录安全面，列入二期待拍板 §8-D5）；采购场景现有「供应商上传渠道」（FileRequirement.externalOrgId 指定条目）继续走原流程不受影响。

### 3.3 软删除/回收站
- File 与 FileCatalog 各加 `deletedAt/deletedById`；软删=打标（不物理删，不占配额计算除外——回收站仍占配额，防止用回收站绕过配额）。
- 保留期 **30 天**（env `DRIVE_RECYCLE_RETAIN_DAYS` 可调），到期由现有定时任务框架物理清除（purge 时同时删物理文件+FileAccessLog 保留审计链）。
- 权限：恢复=删除者本人或 MANAGER/OWNER；彻底删除（手动 purge）=MANAGER/OWNER；回收站视图按操作者过滤（MEMBER 只见自己删的，MANAGER/OWNER 见全部）。

### 3.4 文件操作集
- **上传**：复用 /api/files/upload 管线（sha256 校验/配额检查/MIME 白名单/审计），扩展入参 `{folderId}`（无 requirementId 直挂网盘目录）；前端多文件选择+拖拽到目录树/列表区。
- **下载**：复用 accessFile（Range 206 流式）；新增**批量打包** `GET /api/files/batch-download?ids=` 服务端 zip 流式返回（内存友好：边读边写 zip 流，单批上限 100 文件）。
- **移动/复制**：移动改 folderId（DB-only，物理不动）；复制=读源文件字节写新 storagePath+新记录（同项目内），仅一期做移动，复制列二期。
- **重命名**：File.originalName/name 更新（storagePath 不变）。
- **预览**：完全复用现有 preview（inline 流式）与前端 FilePreviewDialog。

### 3.5 全局搜索
- 新增 `GET /api/files/search?q=`：跨用户可见项目（复用 data-visibility.ts 可见项目集）按文件名 originalName/name contains（PG insensitive）搜索，返回带项目名/目录路径面包屑，默认限 50 条。不建新索引（PG btree/ILIKE 在当前数据量够用），全文索引列二期。

### 3.6 大文件与配额
- **维持不变**：单文件 100MB（FILE_MAX_SIZE）、项目配额 10GB（FILE_QUOTA_PER_PROJECT），网盘与交付文件共享同一项目配额池。理由：现有额度是 owner 定的工程约束，网盘化不改变存储总量；如后续吃紧调 env 即可，无需代码变更。

### 3.7 审计与合规
- FileAccessAction 枚举扩展：`CREATE(目录创建) RENAME DELETE(软删) RESTORE PURGE COPY`。
- 所有网盘写操作沿用 ActivityLog（file-catalog.create 等）+ FileAccessLog 双留痕；回收站 purge 后日志保留（现有 SetNull 机制）。

### 3.8 版本管理
- **自由文件同名上传→同记录新版本**（复用 version 列）：同 folderId+同 originalName 再上传 = version+1，历史版本时间线复用 version-timeline 组件。避免 Windows 式"xxx(1).txt"文件名污染。
- 交付条目文件沿用现有同条目 version 递增（语义不变）。
- 例外：上传时显式改名（用户改了显示名）= 新独立文件。

### 3.9 存储迁移
- **零搬迁**：storagePath 永不变更；新上传网盘文件落 `{FILE_ROOT}/{projectId}/{folderId}/{uuid}.{ext}`（folderId 与 catalogId 同源同格式，写盘函数零改动）。
- 存量 File 回填 folderId：从 storagePath 前缀解析 catalogId → 校验存在 → 写入；解析失败的兜底 requirement.catalogId → 再兜底项目第一个 SYSTEM 根（并告警清单输出）。一次性 migration 脚本，幂等可重跑。

### 3.10 前端形态
- /files 页改双 Tab：「交付计划」（现有视图原样）/「**项目网盘**」。
- 网盘 Tab：左=目录树（懒展开、右键菜单：新建/重命名/移动/删除/权限(二期)）；右=面包屑+工具栏（上传/新建文件夹/搜索框/回收站入口）+文件列表（图标/列表双视图，Windows 资源管理器式，混排条目行带状态徽章）；行操作：预览/下载/移动/重命名/删除；多选+批量下载/批量删除；拖拽：文件拖入左侧目录=移动。
- 移动端（App WebView）：响应式——窄屏时目录树收起为顶部面包屑下拉，列表单列，上传走 input file multiple（App 壳已支持文件选择）；复杂拖拽降级为"移动"按钮弹窗选目录。
- 回收站：独立弹层视图（树形结构还原+恢复/彻底删除+剩余保留天数显示）。

### 3.11 性能
- 目录树懒加载：GET catalogs 增量返回（一期沿用全量建树——单项目目录数<百级实测无压力，二期改按需拉取）。
- 文件列表服务端分页（50/页，orderBy name）；深递归权限判定用祖先链缓存（每目录物化 path 物化列 `path text`（如 `/rootId/.../selfId`）一期即做，继承判定/回收站整树软删/面包屑全靠它，避免递归 CTE）。
- 批量 zip 流式输出不落盘。

---

## 4. 数据模型变更（prisma diff）

```prisma
enum FolderKind { SYSTEM  USER }

model FileCatalog {
  // …现有字段不变…
  kind        FolderKind @default(USER)   // SYSTEM=阶段目录(受保护) USER=用户自建
  path        String     // 物化路径 '/anc1/anc2/self' 祖先链判定/整树软删/面包屑
  deletedAt   DateTime?
  deletedById String?
}

model File {
  // …现有字段不变…
  folderId    String?      // ★ 显式目录外键（存量回填；新网盘文件必填）
  folder      FileCatalog? @relation(fields: [folderId], references: [id])
  deletedAt   DateTime?
  deletedById String?
  @@index([projectId, folderId])          // 网盘列表主查询
  @@index([folderId, originalName])       // 同名版本合并判定
}

enum FileAccessAction { // 扩展
  VIEW DOWNLOAD UPLOAD APPROVE REJECT OBSOLETE MOVE
  CREATE RENAME DELETE RESTORE PURGE COPY   // 新增
}
```

> 不新建任何表；不做 ExternalOrg 直挂网盘的模型（二期视拍板加 DriveShare）。

## 5. API 设计（新增/扩展，REST 复用现有 apiHandler 风格）

| Method | Path | 说明 | 权限 |
|--------|------|------|------|
| GET | /api/projects/[id]/catalogs | 扩展：返回 kind/path/软删过滤；`?view=recycle` 回收站树 | PROJECT.view |
| POST/PATCH/DELETE | 同上（现有） | 扩展：USER 目录放开自由建改删（软删整树）；SYSTEM 目录 403 保护 | 文件夹级 upload/edit/delete（§3.2 公式） |
| GET | /api/drive/list | `?projectId&folderId&page` 文件+条目合并列表（分页） | 文件夹 view |
| POST | /api/files/upload（现有扩展） | 入参加 `folderId`（免 requirement 直挂网盘，同名→version+1） | 文件夹 upload |
| PATCH | /api/files/[id] | 重命名 | 文件 edit |
| POST | /api/files/[id]/move（现有扩展） | 入参加 `folderId`（DB-only 移动） | 源 edit+目标 edit |
| POST | /api/files/batch | `{ids, action: delete\|restore\|purge}` 批量回收站操作 | delete 级 |
| GET | /api/files/batch-download | `?ids=` zip 流（≤100 文件） | 各文件 download |
| GET | /api/files/search | `?q=` 跨项目文件名搜索 | data-visibility 过滤 |
| GET | /api/files/[id]/versions | 自由文件版本列表（复用条目时间线结构） | view |

## 6. 迁移方案（一次性 SQL migration + 回填脚本，零停机）

1. **M1 加列**：全部可空新增列（kind 默认回填见 M2），无锁表风险。
2. **M2 回填 kind/path**：`phaseCode IS NOT NULL OR 目录名匹配 'NN-阶段名'` → SYSTEM，其余 → USER；path 沿树物化。
3. **M3 收拢系统区**（待拍板 D2）：每项目新建 SYSTEM 目录「00-交付计划」，20 个阶段目录 parentId 改挂其下（catalogId 不变 → FileRequirement/File 引用零破坏）；用户自建目录与「00-交付计划」并列于根级，结构清爽。
4. **M4 回填 File.folderId**：storagePath 前缀解析 → requirement.catalogId 兜底 → SYSTEM 根兜底+告警清单；幂等可重跑。
5. **M5 动作枚举扩展**：PG enum ADD VALUE（不破坏存量）。
6. 验证：回填后抽样比对 storagePath 前缀与 folderId 一致率 100%；/files 交付计划视图回归全绿。

## 7. 开发分期

**一期（最小可用，5 个工作块，目标=owner 核心诉求全闭环）**
- W1 数据层：M1-M5 迁移+回填+校验脚本
- W2 API 层：§5 全部端点+权限分支（permission.ts 加 FILE_FOLDER 判定）+审计
- W3 前端：网盘 Tab（左树右列表/面包屑/拖拽/回收站/批量下载）
- W4 App 适配：WebView 响应式验证+上传链路真机回归
- W5 测试收口：越权用例（非成员/跨部门/SYSTEM 保护/回收站权限）+配额/大文件+回归交付计划全流程 → 上线

**二期（增强，按需排期）**
- 文件夹 RESTRICTED 范围收紧（部门可见性白名单模式）、外链只读分享（供应商场景）、复制、全文搜索索引、树懒加载、版本对比、缩略图

## 8. Owner 拍板关口表（✅ 2026-08-30 owner 全权授权：D1-D7 全部按推荐生效，后续 S3-S6 无需再等拍板）

| # | 拍板项 | 推荐 | 拍板 |
|---|--------|------|------|
| D1 | 共存策略选 **B 融合制**（一棵树，阶段目录=受保护系统文件夹） | ✅ 推荐 | ✅ 生效 |
| D2 | 20 个阶段目录**收拢**进「00-交付计划」系统组，与自建目录并列根级 | ✅ 推荐（不收拢亦可，树稍乱） | ✅ 生效 |
| D3 | 回收站保留 **30 天**，到期自动彻底删除 | ✅ 推荐 | ✅ 生效 |
| D4 | 网盘同名上传=**新版本**（非 Windows 式自动改名副本） | ✅ 推荐 | ✅ 生效 |
| D5 | 供应商外链只读分享：一期**不做**，二期再议 | ✅ 推荐（安全面） | ✅ 生效 |
| D6 | 配额维持 10GB/项目、单文件 100MB 不变 | ✅ 推荐 | ✅ 生效 |
| D7 | /files 页双 Tab（交付计划/项目网盘）而非只留网盘 | ✅ 推荐 | ✅ 生效 |
