/**
 * backfill-jobtitle.ts — 补录 jobTitle 为空的用户岗位（audit P1-3）
 *
 * 依据 prisma/data/company-employees.json 的 staff 条目与 rules.jobTitleMapping：
 *   1. staff 条目已给出 jobTitle（真实职务→13岗位字典映射）→ 直接补录；
 *   2. 映射规则明确「无岗位绑定」的职务（总经理/总经理助理/财务/人事 +
 *      车间工人：焊工/装配工/抛光/下料/普工/学徒/仓管等）→ 设计上不绑岗位，跳过；
 *   3. 其余（职务未知，staff.note 标注「待人事确认」）→ 保持空，输出待人工确认清单。
 *
 * 运行：npx tsx scripts/backfill-jobtitle.ts [--dry-run]
 * 幂等：仅更新 jobTitle 为 null/空串 的用户。
 */

import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

interface StaffEntry {
  name: string
  titleOriginal: string
  dept: string
  jobTitle: string | null
  note?: string | null
  email: string
}

/** rules.jobTitleMapping：真实职务 → 13 岗位字典（可推断项） */
const TITLE_TO_JOB: Record<string, string> = {
  技术总监: '技术负责人',
  项目负责人: '项目经理',
  高级电气工程师: '电气工程师',
  工艺工程师: '工艺工程师',
  机械工程师: '机械工程师',
  销售工程师: '商务经理',
  采购总监: '采购专员',
  生产厂长: '生产主管',
  生产助理: '生产主管',
  文员: '资料员',
}

/** 映射规则明确「无岗位绑定」的原职务（管理/后勤/车间一线） */
const NO_BINDING = new Set([
  '总经理',
  '总经理助理',
  '财务',
  '人事',
  '人事负责人',
  // 车间工人，不参与流程岗位绑定
  '焊工',
  '装配工',
  '抛光',
  '抛光学徒',
  '下料',
  '普工',
  '学徒',
  '仓管',
])

async function main() {
  const jsonPath = path.join(__dirname, '..', 'prisma', 'data', 'company-employees.json')
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as { staff: StaffEntry[] }
  const byEmail = new Map<string, StaffEntry>()
  for (const s of data.staff) byEmail.set(s.email.toLowerCase(), s)

  const users = await prisma.user.findMany({
    where: { OR: [{ jobTitle: null }, { jobTitle: '' }] },
    select: { id: true, name: true, email: true, duties: true, role: true },
    orderBy: { createdAt: 'asc' },
  })

  const backfilled: string[] = []
  const byDesign: string[] = []
  const manual: string[] = []

  for (const u of users) {
    const staff = byEmail.get(u.email.toLowerCase())
    let target: string | null = null
    let reason: 'staff' | 'mapping' | 'no-binding' | 'manual' = 'manual'

    if (staff?.jobTitle) {
      target = staff.jobTitle
      reason = 'staff'
    } else if (staff?.titleOriginal && TITLE_TO_JOB[staff.titleOriginal]) {
      target = TITLE_TO_JOB[staff.titleOriginal]
      reason = 'mapping'
    } else if (staff && NO_BINDING.has(staff.titleOriginal)) {
      reason = 'no-binding'
    } else if (!staff) {
      // DB 里有但 employees.json 无记录：尝试从 duties「原职务：X」推断
      const m = /^原职务[：:]\s*(.+)$/.exec(u.duties ?? '')
      const orig = m?.[1]?.trim() ?? ''
      if (orig && TITLE_TO_JOB[orig]) {
        target = TITLE_TO_JOB[orig]
        reason = 'mapping'
      } else if (orig && NO_BINDING.has(orig)) {
        reason = 'no-binding'
      }
    }

    if (target) {
      if (!DRY) {
        await prisma.user.update({ where: { id: u.id }, data: { jobTitle: target } })
      }
      backfilled.push(`${u.name}（${u.email}）→ ${target}【${reason === 'staff' ? 'staff 表给定' : '映射推断'}】`)
    } else if (reason === 'no-binding') {
      const orig = staff?.titleOriginal || (u.duties ?? '').replace(/^原职务[：:]/, '').trim() || '未知'
      byDesign.push(`${u.name}（${u.email}）— 原职务「${orig}」按映射规则无岗位绑定`)
    } else {
      manual.push(`${u.name}（${u.email}）— ${staff?.note || '职务信息缺失，待人事确认'}`)
    }
  }

  console.log(`\n===== 岗位补录结果（${DRY ? 'dry-run 预演' : '已写入'}）=====`)
  console.log(`jobTitle 为空用户总数：${users.length}\n`)

  console.log(`【已补录 ${backfilled.length} 人】`)
  backfilled.forEach((s) => console.log('  ✅ ' + s))

  console.log(`\n【设计上无岗位绑定，保持空 ${byDesign.length} 人】（映射规则：车间工人/行政后勤不绑流程岗位）`)
  byDesign.forEach((s) => console.log('  ⏭️  ' + s))

  console.log(`\n【待人工确认 ${manual.length} 人】（保持空，请人事确认后在 系统管理→用户管理→编辑 补录）`)
  manual.forEach((s) => console.log('  ❓ ' + s))

  // 补录后 13 岗位字典覆盖检查（实例化负责人匹配相关）
  const covered = await prisma.user.groupBy({
    by: ['jobTitle'],
    where: {
      isActive: true,
      AND: [{ jobTitle: { not: null } }, { jobTitle: { not: '' } }],
    },
    _count: { _all: true },
  })
  console.log(`\n【补录后岗位覆盖】`)
  for (const c of covered) {
    console.log(`  ${c.jobTitle}: ${c._count._all} 人`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
