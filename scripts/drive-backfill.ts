/**
 * 网盘化改造 W1 · M2-M4 数据回填（幂等可重跑）
 * change-id: 20260830-drive-war ｜ 2026-08-30
 *
 * M2: kind 判定（phaseCode 非空 → SYSTEM）+ path 物化（递归 CTE 全量重算）
 * M3: 每项目新建「00-交付计划」SYSTEM 组（幂等 find-or-create），根级阶段目录改挂其下（catalogId 不变）
 * M4: File.folderId 回填（storagePath 前缀解析 → requirement.catalogId 兜底 → 00-交付计划 兜底+告警）
 *
 * 用法:
 *   npx tsx scripts/drive-backfill.ts --dry-run   # 只打印诊断与计划，不执行
 *   npx tsx scripts/drive-backfill.ts             # 执行回填
 *   npx tsx scripts/drive-backfill.ts --verify    # 只跑校验（抽样一致率）
 *
 * 安全: 所有 UPDATE 均带幂等条件；跑前已由战役纪律强制 backup-pm.sh。
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')
const VERIFY_ONLY = process.argv.includes('--verify')

const GROUP = '00-交付计划'

async function projectIds(): Promise<string[]> {
  const rows = await prisma.project.findMany({ select: { id: true } })
  return rows.map((r) => r.id)
}

/** M2a: kind 判定 */
async function backfillKind(): Promise<void> {
  const n = await prisma.fileCatalog.count({ where: { phaseCode: { not: null } } })
  console.log(`[M2] phaseCode 非空（→SYSTEM）目录数: ${n}`)
  if (DRY) return
  const r = await prisma.$executeRaw`
    UPDATE "FileCatalog" SET kind = 'SYSTEM' WHERE "phaseCode" IS NOT NULL AND kind <> 'SYSTEM'`
  console.log(`[M2] kind 更新行数: ${r}`)
}

/** M2b: path 物化（全量重算，幂等） */
async function backfillPath(): Promise<void> {
  const missing = await prisma.fileCatalog.count({ where: { path: '' } })
  console.log(`[M2] path 为空的目录数: ${missing}`)
  if (DRY) return
  const r = await prisma.$executeRaw`
    WITH RECURSIVE tree AS (
      SELECT id, ARRAY[id]::text[] AS chain FROM "FileCatalog" WHERE "parentId" IS NULL
      UNION ALL
      SELECT c.id, t.chain || c.id
      FROM "FileCatalog" c JOIN tree t ON c."parentId" = t.id
      WHERE NOT t.chain @> ARRAY[c.id]  -- 环保护
    )
    UPDATE "FileCatalog" fc SET path = '/' || array_to_string(t.chain, '/')
    FROM tree t WHERE t.id = fc.id AND fc.path <> '/' || array_to_string(t.chain, '/')`
  console.log(`[M2] path 更新行数: ${r}`)
}

/** M3: 收拢系统区（每项目「00-交付计划」组） */
async function regroupSystem(): Promise<void> {
  const pids = await projectIds()
  let created = 0
  let moved = 0
  for (const pid of pids) {
    // find-or-create 组根（幂等）
    let wrapper = await prisma.fileCatalog.findFirst({
      where: { projectId: pid, parentId: null, name: GROUP, kind: 'SYSTEM' },
      select: { id: true },
    })
    if (!wrapper) {
      const roots = await prisma.fileCatalog.count({ where: { projectId: pid } })
      if (roots === 0) continue // 无目录的项目不建组
      if (DRY) {
        console.log(`[M3] 项目 ${pid}: 将创建「${GROUP}」组`)
      } else {
        wrapper = await prisma.fileCatalog.create({
          data: {
            projectId: pid,
            parentId: null,
            name: GROUP,
            phaseCode: null,
            order: -1,
            remark: '系统目录组：交付计划阶段目录（自动收拢，受保护）',
            kind: 'SYSTEM',
          },
          select: { id: true },
        })
        created++
      }
    }
    if (!wrapper) continue
    // 根级 SYSTEM 阶段目录改挂组下（幂等：已挂的 parentId 已非 null 自动跳过）
    if (DRY) {
      const n = await prisma.fileCatalog.count({
        where: { projectId: pid, parentId: null, kind: 'SYSTEM', phaseCode: { not: null }, id: { not: wrapper.id } },
      })
      if (n > 0) console.log(`[M3] 项目 ${pid}: ${n} 个根级阶段目录将改挂「${GROUP}」下`)
    } else {
      const r = await prisma.fileCatalog.updateMany({
        where: { projectId: pid, parentId: null, kind: 'SYSTEM', phaseCode: { not: null }, id: { not: wrapper.id } },
        data: { parentId: wrapper.id },
      })
      moved += r.count
    }
  }
  console.log(`[M3] 创建组: ${created}，改挂阶段目录: ${moved}${DRY ? '（dry-run 未执行）' : ''}`)
}

/** M4: File.folderId 回填 */
async function backfillFolderId(): Promise<void> {
  const pending = await prisma.file.count({ where: { folderId: null } })
  console.log(`[M4] folderId 为空的文件数: ${pending}`)
  if (DRY || pending === 0) return

  // 路径 1: storagePath 前缀解析（{projectId}/{catalogId}/{uuid}.ext）
  const r1 = await prisma.$executeRaw`
    UPDATE "File" f SET "folderId" = s.seg
    FROM (SELECT id, split_part("storagePath", '/', 2) AS seg FROM "File" WHERE "folderId" IS NULL) s
    WHERE f.id = s.id
      AND EXISTS (SELECT 1 FROM "FileCatalog" c WHERE c.id = s.seg AND c."projectId" = f."projectId")`
  console.log(`[M4] 路径1 前缀解析命中: ${r1}`)

  // 路径 2: requirement.catalogId 兜底
  const r2 = await prisma.$executeRaw`
    UPDATE "File" f SET "folderId" = r."catalogId"
    FROM "FileRequirement" r
    WHERE f."requirementId" = r.id AND f."folderId" IS NULL`
  console.log(`[M4] 路径2 条目目录兜底: ${r2}`)

  // 路径 3: 项目「00-交付计划」组兜底 + 告警清单
  const rest = await prisma.file.findMany({
    where: { folderId: null },
    select: { id: true, projectId: true, originalName: true, storagePath: true },
  })
  const warn: typeof rest = []
  for (const f of rest) {
    const wrapper = await prisma.fileCatalog.findFirst({
      where: { projectId: f.projectId, parentId: null, kind: 'SYSTEM', name: GROUP },
      select: { id: true },
    })
    if (wrapper) {
      await prisma.file.update({ where: { id: f.id }, data: { folderId: wrapper.id } })
    } else {
      warn.push(f)
    }
  }
  console.log(`[M4] 路径3 组根兜底: ${rest.length - warn.length}`)
  if (warn.length > 0) {
    console.warn(`[M4] ⚠️ 无法回填的孤儿文件 ${warn.length} 个（项目无目录）:`)
    for (const f of warn) console.warn(`    - ${f.id} ${f.originalName} ${f.storagePath}`)
  }
}

/** 校验：抽样一致率 + 完整性 */
async function verify(): Promise<void> {
  const total = await prisma.file.count()
  const noFolder = await prisma.file.count({ where: { folderId: null } })
  const noPath = await prisma.fileCatalog.count({ where: { path: '' } })
  const orphanFolder = await prisma.file.count({
    where: { folderId: { not: null }, folder: null },
  })

  // 一致率：folderId 与 storagePath 前缀（仅统计前缀确实指向有效 catalog 的行）
  const rows = await prisma.$queryRaw<{ total: bigint; consistent: bigint }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE f."folderId"::text = split_part(f."storagePath", '/', 2)) AS consistent
    FROM "File" f
    WHERE EXISTS (SELECT 1 FROM "FileCatalog" c WHERE c.id = split_part(f."storagePath", '/', 2))`

  const { total: t, consistent: c } = rows[0]
  const rate = Number(t) === 0 ? 100 : (Number(c) / Number(t)) * 100

  console.log('──────── 校验报告 ────────')
  console.log(`File 总数: ${total} ｜ folderId 空: ${noFolder} ｜ 悬挂 folderId: ${orphanFolder}`)
  console.log(`FileCatalog path 空: ${noPath}`)
  console.log(`前缀一致率: ${rate.toFixed(2)}% (${c}/${t})`)
  const pass = noFolder === 0 && orphanFolder === 0 && noPath === 0 && rate === 100
  console.log(pass ? '✅ 校验全过（一致率 100%）' : '❌ 校验未过，检查上方数字')

  // 抽样展示 5 条
  const sample = await prisma.file.findMany({
    take: 5,
    where: { folderId: { not: null } },
    select: { id: true, originalName: true, storagePath: true, folderId: true, folder: { select: { name: true, kind: true } } },
  })
  for (const s of sample) {
    console.log(`  样例 ${s.originalName} → ${s.folder?.name}(${s.folder?.kind}) folderId=${s.folderId}`)
  }
  if (!pass) process.exitCode = 1
}

async function main() {
  console.log(`[drive-backfill] 开始 ${DRY ? '（DRY-RUN）' : ''} ${new Date().toISOString()}`)
  if (!VERIFY_ONLY) {
    await backfillKind()
    await backfillPath()
    await regroupSystem()
    await backfillPath() // M3 改挂后重算 path
    await backfillFolderId()
  }
  await verify()
}

main()
  .catch((e) => {
    console.error('[drive-backfill] 失败:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
