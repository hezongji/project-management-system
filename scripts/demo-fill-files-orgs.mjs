#!/usr/bin/env node
/**
 * demo-fill-files-orgs.mjs —— 演示数据填充：文件目录/条目/真实多版本文件 + 客户联系人 + 项目台账补全
 *
 * 职责（只写本脚本职责范围内的表）：
 *   1. FileRequirement：15 个项目 × 每阶段补足条目（总条目补到 2-4/阶段），
 *      状态覆盖 WAITING/SUBMITTED/REVIEWING/APPROVED/REJECTED/NA/OBSOLETED 全谱
 *   2. File + 物理 + FileAccessLog：60 个 APPROVED/SUBMITTED 条目 × 2-3 个真实版本文件
 *      （物理文件按 file-storage.ts 的 writeUploadFile 逻辑落盘：{FILE_ROOT}/{projectId}/{catalogId}/{hex32}.{ext}，
 *       DB 存相对 FILE_ROOT 的路径；同名确定性覆盖）
 *   3. ExternalContact：为 CUSTOMER 类 ExternalOrg 每家 0-3 个虚构联系人
 *   4. Project 台账：amount=null 补金额（30 万-800 万），signedAt=null 补签约日（plannedStart 前）；
 *      日期自洽性只检测报告、不修改（本脚本仅允许 UPDATE Project 的 amount/signedAt）
 *
 * 幂等：运行前按可识别特征清理自己历史插入的
 *   - File          originalName 含 '演示-'
 *   - FileRequirement remark 含 'DEMO-FILL'
 *   - ExternalContact remark 含 'DEMO-FILL'
 *   - 上述 File 对应的 FileAccessLog（fileId in …）、uploads 物理文件（按记录内 storagePath 删除）
 *
 * 用法：cd 项目根 && node scripts/demo-fill-files-orgs.mjs
 * 幂等可重复运行。确定性随机（mulberry32，种子来自项目编号/条目序号）。
 */

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { promises as fs } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

// ───────────────────────────── env（.env 的 DATABASE_URL / FILE_ROOT）─────────────────────────────
function loadEnv(p = path.join(process.cwd(), '.env')) {
  try {
    const txt = readFileSync(p, 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    /* .env 缺失时用环境变量兜底 */
  }
}
loadEnv()

const prisma = new PrismaClient()

/** FILE_ROOT：与 src/lib/file-storage.ts fileRoot() 同规则（env 优先，默认 cwd/uploads） */
function fileRoot() {
  const envRoot = process.env.FILE_ROOT
  if (envRoot && envRoot.trim()) return path.resolve(envRoot.trim())
  return path.join(process.cwd(), 'uploads')
}
const ROOT = fileRoot()

// ───────────────────────────── 确定性随机 ─────────────────────────────
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ───────────────────────────── 标识与标记 ─────────────────────────────
const REQ_MARK = 'DEMO-FILL 演示条目'
const CT_MARK = 'DEMO-FILL 演示联系人'
const FILE_PREFIX = '演示-'

// ───────────────────────────── 文案池（虚构，无真实业务词）─────────────────────────────
const DOC_KINDS = [
  { kind: '技术方案', ext: 'md', mime: 'text/markdown' },
  { kind: '施工记录', ext: 'txt', mime: 'text/plain' },
  { kind: '评审报告', ext: 'pdf', mime: 'application/pdf' },
  { kind: '点检清单', ext: 'md', mime: 'text/markdown' },
  { kind: '验收单', ext: 'pdf', mime: 'application/pdf' },
  { kind: '培训纪要', ext: 'txt', mime: 'text/plain' },
  { kind: '发货清单', ext: 'md', mime: 'text/markdown' },
  { kind: '联络函', ext: 'txt', mime: 'text/plain' },
  { kind: '变更确认单', ext: 'pdf', mime: 'application/pdf' },
  { kind: '检测报告', ext: 'pdf', mime: 'application/pdf' },
]
const PURPOSES = ['存档', '报审', '客户交付', '施工依据']
const STATUSES = ['APPROVED', 'SUBMITTED', 'WAITING', 'REVIEWING', 'REJECTED', 'NA', 'OBSOLETED']
const REVIEW_STATUSES = new Set(['SUBMITTED', 'REVIEWING', 'APPROVED', 'REJECTED'])
const CT_SURNAMES = ['沈', '董', '孟', '裴', '阮', '穆', '屠', '池', '荀', '濮', '阚', '岳', '关', '聂', '靳', '厍', '郤', '詹', '糜', '瞿', '晏', '荣', '冷', '桑', '宿']
const CT_GIVENS = ['书涵', '绍辉', '婉晴', '鸿轩', '静姝', '承志', '文翰', '雨薇', '明轩', '思远', '清越', '峙渊', '霁月', '云帆', '若谷', '海川', '景行', '望舒', '知许', '叙白', '聿修', '其琛', '维桢', '南乔', '予安']
const CT_TITLES = ['采购经理', '项目经理', '设备主管', '工艺工程师', '电气工程师', '财务专员', '物流专员']

// ───────────────────────────── 幂等清理 ─────────────────────────────
async function cleanup() {
  const myFiles = await prisma.file.findMany({
    where: { originalName: { startsWith: FILE_PREFIX } },
    select: { id: true, storagePath: true },
  })
  if (myFiles.length) {
    await prisma.fileAccessLog.deleteMany({ where: { fileId: { in: myFiles.map((f) => f.id) } } })
  }
  let removedBytes = 0
  for (const f of myFiles) {
    // storagePath 是相对 FILE_ROOT 的路径（file-storage.ts 决策），拼回绝对路径删除
    const abs = path.resolve(ROOT, f.storagePath || '')
    const rel = path.relative(ROOT, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue // 越界保护
    try {
      await fs.unlink(abs)
      removedBytes++
    } catch {
      /* 文件不存在则跳过 */
    }
  }
  const delFiles = await prisma.file.deleteMany({ where: { originalName: { startsWith: FILE_PREFIX } } })
  const delReqs = await prisma.fileRequirement.deleteMany({ where: { remark: { contains: 'DEMO-FILL' } } })
  const delCts = await prisma.externalContact.deleteMany({ where: { remark: { contains: 'DEMO-FILL' } } })
  console.log(`[cleanup] 删除 File=${delFiles.count}，物理文件=${removedBytes}，FileRequirement=${delReqs.count}，ExternalContact=${delCts.count}`)
}

// ───────────────────────────── 内容生成 ─────────────────────────────
/** 生成演示文件字节：txt/md 为文本；pdf 为最小合法 PDF 头 */
function docBuffer(reqName, kind, version, projectCode, phaseName, ext) {
  const body = [
    `${reqName}（${phaseName}）`,
    `项目编号：${projectCode}`,
    `文档类别：${kind}`,
    `版本：V${version}`,
    '',
    '本文件由项目管理系统演示数据脚本自动生成，用于功能与数据流测试。',
    '',
    '一、范围与目的',
    '本文档覆盖本阶段交付物的编制、校核与归档要求，作为过程追溯依据。',
    '二、执行标准',
    '参照公司质量管理体系文件及行业通用规范执行。',
    '三、验收准则',
    '内容完整、签署齐全、版本受控，归档后纳入项目竣工资料包。',
  ].join('\n')
  if (ext === 'pdf') {
    const header = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
    return Buffer.from(`${header}% ${body}\n`.padEnd(1024, '%') + '\n%%EOF\n', 'utf8')
  }
  if (ext === 'md') {
    return Buffer.from(`# ${reqName} V${version}\n\n${body}\n`, 'utf8')
  }
  return Buffer.from(`【${reqName}】V${version}\n\n${body}\n`, 'utf8')
}

const pad2 = (n) => String(n).padStart(2, '0')

// ───────────────────────────── 主流程 ─────────────────────────────
async function main() {
  console.log(`[env] FILE_ROOT=${ROOT}`)
  console.log(`[env] DATABASE_URL=${(process.env.DATABASE_URL || '').replace(/:[^:@/]*@/, ':***@')}`)
  await cleanup()

  const base = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  // ── 1. 选 15 个项目：非归档、阶段数≥10、成员数≥3（确定性：按 code 排序）──
  const candidates = await prisma.project.findMany({
    where: { isArchived: false, status: { in: ['ACTIVE', 'ON_HOLD', 'COMPLETED'] } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, status: true },
  })
  const projects = []
  for (const p of candidates) {
    if (projects.length >= 15) break
    const [phaseCount, memberCount] = await Promise.all([
      prisma.phase.count({ where: { projectId: p.id } }),
      prisma.projectMember.count({ where: { projectId: p.id } }),
    ])
    if (phaseCount >= 10 && memberCount >= 3) projects.push(p)
  }
  if (!projects.length) throw new Error('没有满足条件的项目（阶段≥10、成员≥3）')
  console.log(`[pick] 选中 ${projects.length} 个项目：${projects.map((p) => p.code).join(', ')}`)

  // ── 2. 全局状态序列（确定性保证全谱覆盖）──
  const statusSeq = []
  {
    const rngS = mulberry32(hashStr('demo-fill-status'))
    const pool = [...STATUSES]
    // 洗牌
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rngS() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    statusSeq.push(...pool) // 前 7 条必覆盖 7 状态
  }

  let reqInserted = 0
  const reqForFiles = [] // { id, name, projectCode, status, ownerId, reviewerId, catalogId, projectId, phaseName }

  for (let pi = 0; pi < projects.length; pi++) {
    const proj = projects[pi]
    const rng = mulberry32(hashStr(`demo-fill:${proj.code}`))

    const phases = await prisma.phase.findMany({
      where: { projectId: proj.id },
      orderBy: { order: 'asc' },
      select: { id: true, code: true, name: true, order: true, plannedEnd: true },
    })
    const members = await prisma.projectMember.findMany({
      where: { projectId: proj.id },
      select: { userId: true },
    })
    const memberIds = members.map((m) => m.userId)
    if (!memberIds.length) continue

    for (const ph of phases) {
      // 目录复用（幂等）：按 projectId+phaseCode 找，缺则补齐标准目录
      let catalog = await prisma.fileCatalog.findFirst({
        where: { projectId: proj.id, phaseCode: ph.code },
        select: { id: true },
      })
      if (!catalog) {
        catalog = await prisma.fileCatalog.create({
          data: {
            projectId: proj.id,
            name: `${pad2(ph.order)}-${ph.name}`,
            phaseCode: ph.code,
            order: ph.order,
          },
          select: { id: true },
        })
      }

      const existing = await prisma.fileRequirement.count({
        where: { projectId: proj.id, phaseCode: ph.code },
      })
      // 补到该阶段总条目 2-4 条
      const insertN = existing >= 4 ? 0 : existing <= 1 ? 3 : 2
      for (let k = 0; k < insertN; k++) {
        const seq = pi * 100 + ph.order * 10 + k
        const rngR = mulberry32(hashStr(`${proj.code}:${ph.code}:${k}`))
        const kindA = DOC_KINDS[(seq + ph.order) % DOC_KINDS.length]
        const kindB = DOC_KINDS[(seq + 3 + pi) % DOC_KINDS.length]
        const docKind = k === 0 ? kindA : kindB
        const reqName = `${ph.name}·${docKind.kind}`
        // 状态：先消耗全谱序列，之后按权重
        const status =
          statusSeq.length
            ? statusSeq.shift()
            : (() => {
                const r = rngR()
                if (r < 0.3) return 'APPROVED'
                if (r < 0.5) return 'SUBMITTED'
                if (r < 0.68) return 'WAITING'
                if (r < 0.8) return 'REVIEWING'
                if (r < 0.88) return 'REJECTED'
                if (r < 0.94) return 'NA'
                return 'OBSOLETED'
              })()
        const ownerId = memberIds[Math.floor(rngR() * memberIds.length)]
        const reviewerId = REVIEW_STATUSES.has(status)
          ? memberIds[Math.floor(rngR() * memberIds.length)]
          : null
        const scopeR = rngR()
        const scope = scopeR < 0.6 ? 'PUBLIC' : scopeR < 0.85 ? 'RESTRICTED' : 'PRIVATE'
        const scopeRefs =
          scope === 'RESTRICTED'
            ? {
                userIds: [
                  memberIds[Math.floor(rngR() * memberIds.length)],
                  memberIds[Math.floor(rngR() * memberIds.length)],
                ].filter((v, i, a) => a.indexOf(v) === i),
                deptIds: [],
              }
            : null
        const created = await prisma.fileRequirement.create({
          data: {
            projectId: proj.id,
            catalogId: catalog.id,
            phaseCode: ph.code,
            name: reqName,
            code: `PROJ-${ph.code}-DF-${pad2(k + 1)}`,
            required: rngR() < 0.85,
            ownerId,
            purpose: PURPOSES[Math.floor(rngR() * PURPOSES.length)],
            scope,
            scopeRefs: scopeRefs ?? undefined,
            dueDate: ph.plannedEnd
              ? new Date(new Date(ph.plannedEnd).getTime() + Math.floor(rngR() * 10) * DAY)
              : null,
            status,
            reviewerId,
            remark: REQ_MARK,
          },
          select: { id: true },
        })
        reqInserted++
        if (status === 'APPROVED' || status === 'SUBMITTED') {
          reqForFiles.push({
            id: created.id,
            name: reqName,
            docKind,
            projectCode: proj.code,
            projectId: proj.id,
            catalogId: catalog.id,
            phaseName: ph.name,
            status,
            ownerId,
            reviewerId,
            memberIds,
            seed: hashStr(`${proj.code}:${ph.code}:${k}`),
          })
        }
      }
    }
  }
  console.log(`[insert] FileRequirement 插入 ${reqInserted} 条（可挂文件条目 ${reqForFiles.length} 个）`)

  // ── 3. 60 个条目挂 2-3 版本真实文件（按项目轮转分散取）──
  const targets = []
  {
    const byProj = new Map()
    for (const r of reqForFiles) {
      if (!byProj.has(r.projectCode)) byProj.set(r.projectCode, [])
      byProj.get(r.projectCode).push(r)
    }
    const buckets = [...byProj.values()]
    let idx = 0
    while (targets.length < Math.min(60, reqForFiles.length)) {
      const b = buckets[idx % buckets.length]
      const item = b.shift()
      if (item) targets.push(item)
      idx++
      if (buckets.every((x) => x.length === 0)) break
    }
  }

  let fileInserted = 0
  let versionCount = 0
  let logInserted = 0
  const writtenPaths = []
  const ACTIONS_POOL = ['VIEW', 'VIEW', 'DOWNLOAD', 'VIEW', 'DOWNLOAD'] // UPLOAD/APPROVE 单独补
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti]
    const rng = mulberry32(t.seed)
    const versions = 2 + (rng() < 0.4 ? 1 : 0)
    for (let v = 1; v <= versions; v++) {
      const ext = t.docKind.ext
      const mime = t.docKind.mime
      const buf = docBuffer(t.name, t.docKind.kind, v, t.projectCode, t.phaseName, ext)
      // 确定性伪 uuid（同种子同名覆盖，幂等不堆积物理文件）
      const hex32 = sha256(`${t.id}:v${v}`).slice(0, 32)
      const relDir = `${t.projectId}/${t.catalogId}`
      const storagePath = `${relDir}/${hex32}.${ext}`
      const absDir = path.join(ROOT, relDir)
      await fs.mkdir(absDir, { recursive: true })
      const abs = path.join(ROOT, storagePath)
      await fs.writeFile(abs, buf)
      writtenPaths.push(abs)

      const uploadedById = t.ownerId
      const createdAt = new Date(base - (45 - ti) * DAY - (versions - v) * DAY)
      const f = await prisma.file.create({
        data: {
          requirementId: t.id,
          projectId: t.projectId,
          name: `${t.name} V${v}`,
          originalName: `${FILE_PREFIX}${t.name}_V${v}.${ext}`,
          storagePath,
          size: buf.byteLength,
          mimeType: mime,
          checksum: sha256(buf),
          version: v,
          uploadedById,
          createdAt,
        },
        select: { id: true },
      })
      fileInserted++
      versionCount++

      // FileAccessLog：UPLOAD（本人）+ VIEW/DOWNLOAD（成员混合）+ APPROVE（审阅人，仅 APPROVED 且最新版）
      const logs = [
        { userId: uploadedById, action: 'UPLOAD', at: new Date(createdAt.getTime() + 3600_000) },
      ]
      const nLogs = 1 + Math.floor(rng() * 3)
      for (let li = 0; li < nLogs; li++) {
        const uid = t.memberIds[Math.floor(rng() * t.memberIds.length)]
        logs.push({
          userId: uid,
          action: ACTIONS_POOL[Math.floor(rng() * ACTIONS_POOL.length)],
          at: new Date(createdAt.getTime() + (li + 2) * 6 * 3600_000),
        })
      }
      if (t.status === 'APPROVED' && v === versions && t.reviewerId) {
        logs.push({
          userId: t.reviewerId,
          action: 'APPROVE',
          at: new Date(createdAt.getTime() + (nLogs + 3) * 6 * 3600_000),
        })
      }
      for (const l of logs) {
        await prisma.fileAccessLog.create({
          data: { fileId: f.id, userId: l.userId, action: l.action, at: l.at },
        })
        logInserted++
      }
    }
  }
  console.log(`[insert] File 插入 ${fileInserted}（${targets.length} 条目 × 2-3 版本），FileAccessLog ${logInserted} 条`)

  // ── 4. 客户联系人：CUSTOMER org 每家 0-3 个（部分无联系人）──
  const orgs = await prisma.externalOrg.findMany({
    where: { type: 'CUSTOMER' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  let ctInserted = 0
  for (let oi = 0; oi < orgs.length; oi++) {
    const org = orgs[oi]
    const rng = mulberry32(hashStr(`demo-fill-ct:${org.id}`))
    if (rng() < 0.15) continue // 部分 org 无联系人
    const n = 1 + Math.floor(rng() * 3)
    const used = new Set()
    for (let k = 0; k < n; k++) {
      const name = `${CT_SURNAMES[(oi * 7 + k * 3) % CT_SURNAMES.length]}${CT_GIVENS[(oi * 5 + k * 11) % CT_GIVENS.length]}`
      if (used.has(name)) continue
      used.add(name)
      await prisma.externalContact.create({
        data: {
          orgId: org.id,
          name,
          title: CT_TITLES[Math.floor(rng() * CT_TITLES.length)],
          phone: `138${String(Math.floor(rng() * 1e8)).padStart(8, '0')}`,
          email: `contact${oi + 1}${k > 0 ? String.fromCharCode(96 + k) : ''}@example.com`,
          remark: CT_MARK,
        },
      })
      ctInserted++
    }
  }
  console.log(`[insert] ExternalContact 插入 ${ctInserted} 个（覆盖 ${orgs.length} 家 CUSTOMER org）`)

  // ── 5. 项目台账补全（只 UPDATE amount / signedAt 两个 null 字段）──
  let amountFilled = 0
  let signedAtFilled = 0
  for (const p of await prisma.project.findMany({
    where: {},
    select: {
      id: true,
      code: true,
      amount: true,
      signedAt: true,
      plannedStart: true,
      status: true,
      actualEnd: true,
      plannedEnd: true,
    },
    orderBy: { code: 'asc' },
  })) {
    const data = {}
    if (p.amount === null || p.amount === undefined) {
      const rng = mulberry32(hashStr(`demo-fill-amt:${p.code}`))
      data.amount = (300000 + rng() * 7700000).toFixed(2) // 30 万-800 万
    }
    if (p.signedAt === null) {
      const rng = mulberry32(hashStr(`demo-fill-sgn:${p.code}`))
      const anchor = p.plannedStart ? new Date(p.plannedStart).getTime() : base - 90 * DAY
      data.signedAt = new Date(anchor - (30 + Math.floor(rng() * 61)) * DAY)
    }
    if (data.amount !== undefined || data.signedAt !== undefined) {
      await prisma.project.update({ where: { id: p.id }, data })
      if (data.amount !== undefined) amountFilled++
      if (data.signedAt !== undefined) signedAtFilled++
    }
  }
  console.log(`[update] Project.amount 补全 ${amountFilled} 个，signedAt 补全 ${signedAtFilled} 个`)

  // ── 6. 日期自洽检测（只报告，不修改）──
  const inconsistent = []
  for (const p of await prisma.project.findMany({
    where: {},
    select: { code: true, status: true, actualEnd: true, plannedStart: true, plannedEnd: true, signedAt: true },
    orderBy: { code: 'asc' },
  })) {
    if (p.status === 'COMPLETED' && !p.actualEnd) inconsistent.push(`${p.code}: COMPLETED 但无 actualEnd`)
    if (p.status === 'ACTIVE' && p.actualEnd) inconsistent.push(`${p.code}: ACTIVE 却有 actualEnd`)
    if (p.signedAt && p.plannedStart && new Date(p.signedAt) > new Date(p.plannedStart))
      inconsistent.push(`${p.code}: signedAt 晚于 plannedStart`)
  }
  console.log(
    inconsistent.length
      ? `[check] 日期自洽问题 ${inconsistent.length} 个（约束仅允许改 amount/signedAt，未修正）：\n  - ${inconsistent.join('\n  - ')}`
      : '[check] 全部项目日期自洽 ✓'
  )

  // ── 7. 物理文件存在性校验 ──
  let missing = 0
  for (const abs of writtenPaths) {
    if (!readFileSyncExists(abs)) missing++
  }
  console.log(`[check] 物理文件 ${writtenPaths.length} 个，缺失 ${missing} 个`)
  if (missing > 0) throw new Error(`${missing} 个物理文件写入校验失败`)

  console.log('\n═══════ demo-fill-files-orgs 完成 ═══════')
  console.log(`  FileRequirement +${reqInserted}（状态全谱覆盖）`)
  console.log(`  File +${fileInserted}（${targets.length} 条目 × 2-3 版本，含物理文件与 sha256）`)
  console.log(`  FileAccessLog +${logInserted}（UPLOAD/VIEW/DOWNLOAD/APPROVE）`)
  console.log(`  ExternalContact +${ctInserted}`)
  console.log(`  Project amount 补 ${amountFilled}、signedAt 补 ${signedAtFilled}`)
}

function readFileSyncExists(p) {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
