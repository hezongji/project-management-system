# HANDOFF · 网盘化改造战役 S3-S6 继任者交接

> ✅ **战役已完成归档（2026-08-30 01:40）**：S1-S6 全走完，生产部署全绿（45/45+9/9回归），交付摘要见同目录 SUMMARY.md（owner 最先看这个）

> 写于 2026-08-30，S1+S2 已完成并经 owner 全权授权。继任者从这里接手。

## 战役状态
- S1 意图 ✅ / S2 设计 ✅（spec.md 已含 D1-D7 拍板结果：全部按推荐生效，**后续阶段无需再等 owner 拍板**）
- commit: 407432a（S1+S2 文档）→ 本 HANDOFF commit
- 下一步: **S3 开工**（按 spec.md §7 一期 W1-W5 执行：数据层迁移→API→前端→App 适配→测试收口）

## Owner 授权边界（安全纪律，原文固化，违反=事故）
1. 只动 **pm.hezongji.cn** 环境
2. 部署避开员工在线时段（工作日 14-18 点为 GLM 错峰同时段也是员工在线高峰，避开；建议夜间/清晨窗口）
3. **任何 DB 迁移前手动跑 `/opt/pm-backup/backup-pm.sh`**
4. `free -m` available < 1200M 时暂停重活（内存紧张易 OOM）
5. 一期 MVP 优先（目录树+增删改+权限继承+上传下载+移动端可用），二期增强后置
6. 全程 .sdlc 工件 + git commit 纪律

## 继任者快速上手
1. 读 spec.md（方案全文）+ intent.md（边界）→ 按此执行，不要重新设计
2. 关键侦察结论已固化在 spec.md §1 表格（File 无 folderId 靠 storagePath 前缀、ResourcePermission 已含 FILE_FOLDER+DEPARTMENT、FileCatalog 已是无限层级树等）
3. W1 数据层迁移风险最高：M1-M5 顺序执行，M4 回填必须幂等可重跑+抽样校验一致率 100%
4. 部署纪律（历史固化）：APK/静态资源走 nginx bind mount /downloads/ 直出不走镜像；NEXT_PUBLIC_WS_URL 只能写 origin 根域名
5. owner 已睡觉，明早看成果：**S3-S6 今晚自主推进，工件说话**
