# S5 Deploy Log — 20260830-mobile-ui

- 日期: 2026-08-30
- 部署目标: pm.hezongji.cn（/opt/pm-app, systemd pm-app）
- 构建: next build 通过（1601 chunks, 37/37 静态页）
- 服务: systemctl restart pm-app → active
- 冒烟: / 200, /im 200, 验收脚本 17/17 PASS
- 回滚路径: git revert a8020a1..HEAD 或 checkout 上一稳定 tag（桌面端零改动，回滚仅影响移动端）

## GO 判定

- owner 已授权继续开工直到全部完成
- 分层评审两道全过（flash 初筛 8/8 + v4-pro 终审 7 类全 PASS）
- 验收 17/17 PASS，桌面回归确认
- 结论: GO（生产已部署生效）
