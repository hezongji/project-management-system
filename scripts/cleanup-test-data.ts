/**
 * cleanup-test-data.ts — 清理 P6 验收前的测试残留数据（幂等）
 *
 * 清理范围（仅明确标识的测试数据，不动真实数据）：
 *   1. 测试项目 code IN ('DEMO26001','DEMO26002') 及其关联数据
 *      - Phase / Task / FileCatalog / FileRequirement / File / ProjectMember
 *        由 Project 外键 onDelete: Cascade 级联删除
 *      - Conversation 的 project 关系为 SetNull（无级联），需先显式删除其会话
 *        （删除 Conversation 会级联删 Message + ConversationMember）
 *      - ActivityLog 的 project 关系同样为 SetNull，需显式删除
 *   2. 测试文件 smoke.pdf 的 File 记录（挂在演示项目 DEMO25021 下，
 *      仅删该文件记录，不动演示项目本体）
 *
 * 运行：npx tsx scripts/cleanup-test-data.ts
 * 幂等：重复运行不会报错，无匹配数据时直接跳过。
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TEST_PROJECT_CODES = ['DEMO26001', 'DEMO26002']
const SMOKE_FILENAMES = ['smoke.pdf']

async function main() {
  const stats = {
    projects: 0,
    conversations: 0,
    messages: 0,
    activityLogs: 0,
    files: 0,
  }

  // ── ① 测试项目及其关联 ──
  const projects = await prisma.project.findMany({
    where: { code: { in: TEST_PROJECT_CODES } },
    select: { id: true, code: true, name: true },
  })

  for (const project of projects) {
    // 1a) 先删项目关联会话（Conversation.project 为 SetNull，不删会残留孤儿会话）
    const conversations = await prisma.conversation.findMany({
      where: { projectId: project.id },
      select: { id: true },
    })
    for (const conv of conversations) {
      stats.messages += await prisma.message.count({ where: { conversationId: conv.id } })
      // 级联删 Message + ConversationMember
      await prisma.conversation.delete({ where: { id: conv.id } })
      stats.conversations += 1
    }

    // 1b) 删活动日志（ActivityLog.project 为 SetNull，不删会残留孤儿记录）
    const deletedLogs = await prisma.activityLog.deleteMany({ where: { projectId: project.id } })
    stats.activityLogs += deletedLogs.count

    // 1c) 删项目本体（级联删 Phase/Task/FileCatalog/FileRequirement/File/ProjectMember）
    await prisma.project.delete({ where: { id: project.id } })
    stats.projects += 1
    console.log(`✓ 删除测试项目 ${project.code}（${project.name}）`)
  }
  if (projects.length === 0) {
    console.log(`未发现测试项目（${TEST_PROJECT_CODES.join('/')}），跳过`)
  }

  // ── ② smoke.pdf 测试文件记录 ──
  const smokeFiles = await prisma.file.findMany({
    where: { OR: SMOKE_FILENAMES.map((n) => ({ name: n })) },
  })
  for (const f of smokeFiles) {
    await prisma.file.delete({ where: { id: f.id } })
    stats.files += 1
    console.log(`✓ 删除测试文件记录 ${f.name}（id=${f.id}）`)
  }
  if (smokeFiles.length === 0) {
    console.log('未发现 smoke.pdf 文件记录，跳过')
  }

  console.log('')
  console.log('════════ 清理结果 ════════')
  console.log(`删除测试项目：${stats.projects}`)
  console.log(`删除关联会话：${stats.conversations}（含消息 ${stats.messages} 条）`)
  console.log(`删除活动日志：${stats.activityLogs}`)
  console.log(`删除 smoke.pdf 文件记录：${stats.files}`)
}

main()
  .catch((e) => {
    console.error('清理失败：', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
