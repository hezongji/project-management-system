/**
 * 回收站到期物理清除（20260830-drive-war W2，spec §3.3 D3）
 *
 * 保留期（DRIVE_RECYCLE_RETAIN_DAYS，默认 30）到期后：
 *  - 文件：审计 PURGE → 删 DB 行（FileAccessLog SetNull 保留）→ 磁盘 best-effort 清理
 *  - 目录：整树物理删（先文件后目录，叶子优先）；要求子树全部已软删且到期
 *
 * 用法: npx tsx scripts/drive-purge-recycle.ts [--dry-run]
 * cron: 40 3 * * * cd /opt/pm-app && npx tsx scripts/drive-purge-recycle.ts >> logs/drive-purge.log 2>&1
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

function retainDays(): number {
  const n = Number(process.env.DRIVE_RECYCLE_RETAIN_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 30
}

async function main() {
  const days = retainDays()
  const cutoff = new Date(Date.now() - days * 86400_000)
  console.log(`[drive-purge-recycle] 开始 ${DRY ? '(DRY-RUN) ' : ''}保留 ${days} 天，截止线 ${cutoff.toISOString()}`)

  // 审计人：首个 ADMIN（FileAccessLog.userId 有 FK，不能用 'system' 字面量）
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
  const actorId = admin?.id ?? null

  // 1. 到期文件（无有效目录归属或目录仍在树上——统一按 deletedAt 判定）
  const files = await prisma.file.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, storagePath: true, projectId: true },
    take: 2000,
  })
  console.log(`[drive-purge-recycle] 到期文件: ${files.length}`)

  if (!DRY) {
    for (const f of files) {
      try {
        if (actorId) {
          await prisma.fileAccessLog.create({
            data: { fileId: f.id, userId: actorId, action: 'PURGE' },
          })
        }
        await prisma.file.delete({ where: { id: f.id } })
        if (f.storagePath) {
          const { resolveStoredFile } = await import('../src/lib/file-storage')
          const { unlink } = await import('fs/promises')
          const abs = resolveStoredFile(f.storagePath)
          if (abs) await unlink(abs).catch(() => {})
        }
      } catch (e) {
        console.warn(`[drive-purge-recycle] 文件清除失败 ${f.id}:`, e)
      }
    }
  }

  // 2. 到期目录（叶子优先：path 降序；子树必须整体已删——防御态跳过未删子孙的）
  const folders = await prisma.fileCatalog.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, path: true, name: true },
    orderBy: { path: 'desc' },
    take: 2000,
  })
  console.log(`[drive-purge-recycle] 到期目录: ${folders.length}`)

  if (!DRY) {
    for (const c of folders) {
      try {
        // 防御：子树内有存活目录/文件则跳过（正常不会发生：软删整树原子打标）
        const aliveChildren = await prisma.fileCatalog.count({
          where: { path: { startsWith: c.path + '/' }, deletedAt: null },
        })
        const aliveFiles = await prisma.file.count({
          where: { folderId: c.id, deletedAt: null },
        })
        if (aliveChildren > 0 || aliveFiles > 0) {
          console.warn(`[drive-purge-recycle] 跳过非整体删除的目录 ${c.id} ${c.name}`)
          continue
        }
        await prisma.fileCatalog.delete({ where: { id: c.id } })
      } catch (e) {
        console.warn(`[drive-purge-recycle] 目录清除失败 ${c.id}:`, e)
      }
    }
  }

  console.log(`[drive-purge-recycle] 完成 ${new Date().toISOString()}`)
}

main()
  .catch((e) => {
    console.error('[drive-purge-recycle] 失败:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
