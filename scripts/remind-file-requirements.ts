/**
 * 文件条目到期催办脚本 —— 依据《开发文档-项目管理系统重构》§7.9
 *
 * 触发方式：
 *   1. 手动：  npx tsx scripts/remind-file-requirements.ts [提前天数]
 *   2. cron：  例（每天 09:00）  0 9 * * *  cd /app && npx tsx scripts/remind-file-requirements.ts 3 >> remind.log 2>&1
 *
 * 行为：对 WAITING/SUBMITTED/REVIEWING 且 dueDate 在「提前天数」（默认 3）天内（含已超期）
 * 的条目生成 TodoItem(FILE_REQ) + Notification(FILE_DUE_SOON) + IM notify:push 提醒责任人；
 * 幂等——责任人名下已有未完成的同名待办则跳过。
 *
 * 退出码：0 正常；1 运行异常（便于 cron 告警）。
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { remindDueRequirements } from '../src/lib/file-review'

async function main(): Promise<void> {
  const daysBeforeArg = Number.parseInt(process.argv[2] ?? '3', 10)
  const daysBefore = Number.isFinite(daysBeforeArg) && daysBeforeArg > 0 ? daysBeforeArg : 3

  console.log(`[remind-file-requirements] 开始催办：提前 ${daysBefore} 天（${new Date().toISOString()}）`)

  const result = await remindDueRequirements({ daysBefore })

  console.log(
    [
      `扫描命中 ${result.scanned} 条`,
      `新建待办 ${result.created} 条`,
      `跳过（已有待办）${result.skipped} 条`,
      `无责任人 ${result.noOwner} 条`,
      `提醒责任人 ${result.notifiedUserIds.length} 人`,
    ].join('；'),
  )
  if (result.notifiedUserIds.length > 0) {
    console.log(`  → ${result.notifiedUserIds.join(', ')}`)
  }
  console.log('[remind-file-requirements] 完成')
}

main()
  .catch((e) => {
    console.error('[remind-file-requirements] 失败：', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
