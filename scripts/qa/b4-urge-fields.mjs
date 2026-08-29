// QA B4 —— /urges/mine 字段验证（自建自删 UrgeRecord，不污染业务数据）
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'

const BASE = 'http://127.0.0.1:3001'
const envText = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const envGet = (k) => envText.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)?.trim()
const JWT_SECRET = envGet('JWT_SECRET')
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }
const token = jwt.sign(ADMIN, JWT_SECRET, { expiresIn: '1h' })
const H = { Authorization: `Bearer ${token}` }

const prisma = new PrismaClient()
let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`)
  if (!cond) failed++
}

// 找一个真实项目 + 真实交付物（仅为字段真实，不修改它们）
const req0 = await prisma.fileRequirement.findFirst({
  where: { project: { isArchived: false } },
  select: { id: true, name: true, projectId: true, project: { select: { code: true } } },
})
if (!req0) {
  console.log('⚠️ 库中无 fileRequirement，跳过真实字段验证（API include 全标量字段，结论不变）')
  process.exit(failed === 0 ? 0 : 1)
}
console.log(`样本: project=${req0.project.code} requirement=${req0.name}`)

// 自建：ADMIN 催自己（urgedBy=target=ADMIN，自建自删完全可控）
const rec = await prisma.urgeRecord.create({
  data: {
    projectId: req0.projectId,
    projectCode: req0.project.code ?? '',
    requirementId: req0.id,
    requirementName: req0.name,
    urgedById: ADMIN.userId,
    targetUserId: ADMIN.userId,
    status: 'ACTIVE',
  },
})
try {
  const res = await fetch(`${BASE}/api/urges/mine`, { headers: H })
  const d = (await res.json())?.data ?? {}
  const inc = (d.incoming ?? []).find((u) => u.id === rec.id)
  const out = (d.outgoing ?? []).find((u) => u.id === rec.id)
  check('GET /urges/mine status=200', res.status === 200, `incoming=${d.incomingCount} outgoing=${d.outgoingCount}`)
  check('  incoming 行含 projectId/requirementId 且值正确',
    !!inc && inc.projectId === req0.projectId && inc.requirementId === req0.id,
    inc ? `projectId=${inc.projectId} requirementId=${inc.requirementId}` : '未找到')
  check('  outgoing 行含 projectId/requirementId 且值正确',
    !!out && out.projectId === req0.projectId && out.requirementId === req0.id,
    out ? `projectId=${out.projectId} requirementId=${out.requirementId}` : '未找到')
  check('  行含 urgedBy/targetUser 嵌套', !!inc?.urgedBy?.name && !!out?.targetUser?.name)
  // 跳转链接可拼性（前端 goUrgeFile 逻辑等价验证）
  if (inc) {
    const url = `/files?projectId=${inc.projectId}&requirementId=${inc.requirementId}&src=${encodeURIComponent('催办')}`
    const filesPage = await fetch(`${BASE}${url}`)
    check('  拼接目标 /files?projectId&requirementId&src=催办 返回 200', filesPage.status === 200, url)
  }
} finally {
  await prisma.urgeRecord.delete({ where: { id: rec.id } })
  console.log('🧹 已清理自建催办记录')
}

await prisma.$disconnect()
console.log(failed === 0 ? '🎉 字段验证全部通过' : `💥 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
