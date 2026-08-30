# S3 计划 · 网盘化改造（plan.md）

> change-id: 20260830-drive-war ｜ 指挥官: 第二任 ｜ 基线: spec.md §7 一期 W1-W5
> 环境: systemd pm-app.service (next 16.3.2 :3001) + 本机 PG pm_dev + 宿主 nginx → pm.hezongji.cn
> 纪律: 迁移前 backup-pm.sh ｜ free<1200M 暂停 ｜ 深夜窗口部署 ｜ 全程 git commit

## 执行拓扑（W1→W5 串行，W3 内部组件并行）

### W1 数据层（风险最高，先行）
1. **前置**: `bash /opt/pm-backup/backup-pm.sh` 确认成功 → 才准 migrate
2. schema.prisma 变更（=spec §4）:
   - `enum FolderKind { SYSTEM USER }`
   - FileCatalog += `kind(FolderKind@default(USER))` `path String` `deletedAt/deletedById`
   - File += `folderId String?` + relation + `deletedAt/deletedById` + 两索引
   - FileAccessAction += `CREATE RENAME DELETE RESTORE PURGE COPY`
3. migration `20260831000000_drive_war_schema`: 纯 DDL（列/索引/enum ADD VALUE，加列全可空无锁表风险）
4. 回填 `scripts/drive-backfill.ts`（幂等可重跑，--dry-run 支持）:
   - M2: kind 判定（phaseCode 非空→SYSTEM）+ path 物化（递归 CTE 一次性 + 应用层增量维护）
   - M3: 每项目建「00-交付计划」SYSTEM 组，根级 SYSTEM 阶段目录改挂其下（catalogId 不变）
   - M4: File.folderId 回填（storagePath 前缀解析→requirement.catalogId 兜底→00-交付计划 兜底+告警清单）
   - 校验: 抽样 storagePath 前缀与 folderId 一致率必须 100%，输出报告
5. lib 层: `src/lib/drive.ts`（path 物化维护/子树判定/软删树判定/权限辅助）

### W2 API 层（permission.ts 加分支 + 端点）
1. permission.ts: FILE_FOLDER 分支返回 path+kind → computePerms 对 FILE_FOLDER 做**祖先链 ACL 并集**（resourceId IN pathIds），复用现有 LRU/失效
2. SYSTEM 保护（API 层）: SYSTEM 目录禁删/禁改名/禁移动（全员）；SYSTEM 目录下建目录/传自由文件仅 MANAGER/OWNER（应急通道）；条目上传走 FILE_REQ 语义不受影响
3. 端点清单（=spec §5）:
   - GET /api/projects/[id]/catalogs 扩展（kind/path/软删过滤/?view=recycle）
   - POST/PATCH/DELETE catalogs 改造（USER 目录文件夹级权限放开建改删=软删整树）
   - GET /api/drive/list（文件+条目合并分页；?view=recycle 回收站）
   - POST /api/files/upload += folderId（同名→version+1）
   - PATCH /api/files/[id]（重命名，DB-only）
   - PATCH /api/files/[id]/move 改 DB-only（folderId 权威，物理不搬；catalogId 入参兼容映射 folderId）
   - POST /api/files/batch（delete|restore|purge）
   - GET /api/files/batch-download（zip 流式 ≤100）
   - GET /api/files/search（文件名 contains，data-visibility 过滤，限 50）
   - GET /api/files/[id]/versions
4. 审计: FileAccessLog 新动作 + ActivityLog + invalidateProject
5. 回收站到期清除: `scripts/drive-purge-recycle.ts`（DRIVE_RECYCLE_RETAIN_DAYS=30）+ crontab 加一行（每日 03:40）

### W3 前端（/files 双 Tab）
1. page.tsx 包 Tabs：「交付计划」（现有逻辑原样）/「项目网盘」（新）
2. `drive-explorer.tsx`: 左树（懒图标/右键菜单）+右列表（面包屑+工具栏+文件行+条目行带徽章）
3. 操作: 上传（多选+拖拽）/新建夹/重命名/移动（弹窗选目录）/删除（软删）/批量下载/批量删除/回收站弹层（恢复/彻底删/剩余天数）
4. 移动端响应式: 窄屏树收起为下拉选择，列表单列，操作走按钮（拖拽降级）
5. services/files.ts 扩展 + types

### W4 App 适配
- build 产物验证 + 响应式 review（HTML/CSS 断言）+ 上传链路 HTTP 级回归
- 真机验收 owner 次日补（test-report 记录待确认）

### W5 测试收口
- `scripts/drive-war-verify.mjs`: 全链断言（建→传→版本→移→改→删→收→恢→purge→批下→搜）+ 权限矩阵（非成员 403/MEMBER 只读 SYSTEM/回收站隔离/MANAGER 可 purge）
- 回归: catalogs GET 原样（交付计划视图）/im-app verify/type-check/lint/build
- 抽样比对报告 + 一致率 100% 证明

## 风险与回滚
- migration 只加可空列/新 enum 值 → 老代码天然兼容（未知 enum 值仅新代码消费）
- 回填脚本幂等，失败可重跑；folderId 回填错误不破坏 storagePath（读盘不依赖它）
- 回滚 = git revert + 反向 DROP COLUMN（备份在手）
- 部署窗口: 深夜（当前时段，员工离线）零重启链路不适用（Next 服务端代码变更需重启 pm-app.service）→ 选择 03:00 后低峰 systemctl restart pm-app（<10s 中断），并在 test-report 记录

## DoD
- [ ] W1-W5 全部完成 + verify 全绿 + 回归全绿
- [ ] 抽样一致率 100% 报告
- [ ] metrics/test-report/交付摘要（非技术 owner 可读）
