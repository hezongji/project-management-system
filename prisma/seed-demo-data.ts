/**
 * seed-demo-data.ts —— 演示数据填充脚本（权威方案：docs/reports/fill-plan-kimi.md）
 *
 * 前置：已跑过 `npm run db:seed`（岗位/模板/51 人/64 项目档案/DEMO25021 深度实例化就位）。
 * 运行：npm run db:seed-demo [--dry-run] [--with-notify] [--only=DEMO25017,...]
 *
 * 设计要点（照方案 §5）：
 *  - 三档实例化：A=ACTIVE 全量 / B=ON_HOLD 轻量 / C=COMPLETED 归档全量 / D=CANCELLED 不动
 *  - 双时间线：流程历史线冻结 T0=2025-09-08（env DEMO_T0 可覆盖）；协作脉搏线用脚本运行时刻 now
 *  - 模板从 DB 读（isDefault 模板 + TemplateStage.deliverables），不复制 STAGES_20
 *  - 复用 matchOwnerForJobTitle / phaseCodeOf / writeUploadFile / sha256（import）
 *  - 幂等三级：项目级（phase.count>0 跳过）/ 实体级（查重键）/ 全局级（成员集合、userId+title）
 *  - 关联铁律：所有 link/sourceId/phaseId/catalogId 一律真实 id，禁止假 link
 *  - 只增不删
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { PrismaClient, Prisma } from '@prisma/client'
import { matchOwnerForJobTitle, phaseCodeOf } from '../src/lib/phase-engine'
import { writeUploadFile, sha256, resolveStoredFile } from '../src/lib/file-storage'

const prisma = new PrismaClient()
const DATA_DIR = join(process.cwd(), 'prisma', 'data')

// ───────────────────────────── 参数 ─────────────────────────────

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const WITH_NOTIFY = argv.includes('--with-notify')
const onlyArg = argv.find((a) => a.startsWith('--only='))
const ONLY: Set<string> | null = onlyArg
  ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null

/** 台账快照日（流程历史线冻结基准，方案 §0.3；env DEMO_T0 可覆盖） */
const T0 = new Date(process.env.DEMO_T0 ?? '2025-09-08')

// ───────────────────────────── 台账结构 ─────────────────────────────

interface HistoryRecord {
  code: string
  name: string
  customer: string | null
  location: string | null
  contractNo: string | null
  signedAt: string | null
  status: string
  archived: boolean
  demoEnriched: boolean
  remark: string | null
}
interface HistoryFile {
  customers: string[]
  projects: HistoryRecord[]
}

// ───────────────────────────── 阶段工期表（方案 §1.1）─────────────────────────────

const DURATIONS: Record<number, number> = {
  1: 3, 2: 7, 3: 2, 4: 10, 5: 15, 6: 10, 7: 15, 8: 20, 9: 10, 10: 5,
  11: 10, 12: 7, 13: 10, 14: 3, 15: 7, 16: 5, 17: 10, 18: 15, 19: 30, 20: 3,
} // 全程 ≈ 197 天

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 3600 * 1000)
}

// ───────────────────────────── 确定性随机（幂等友好，重跑计划一致）─────────────────────────────

function hashStr(s: string): number {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ───────────────────────────── 样例文件字节（方案 §4.2，seed.ts:253 复制+扩展）─────────────────────────────

function sampleDwgBuffer(name: string): Buffer {
  const header = 'AC1027\n0\nSECTION\n2\nHEADER\n9\n$PM_SEED_SAMPLE\n0\nENDSEC\n0\nEOF\n'
  const pad = `; PM 演示样例：${name}\n`.padEnd(1000, '#')
  return Buffer.from(header + pad, 'utf8')
}
function sampleXlsxBuffer(name: string): Buffer {
  const header = 'PK\x03\x04\x14\x00\x00\x00\x00\x00PM-SEED-DEMO\n'
  const pad = `# PM 演示样例表格：${name}\n`.padEnd(1000, '=')
  return Buffer.from(header + pad, 'utf8')
}
function samplePdfBuffer(name: string): Buffer {
  const header = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const pad = `% PM 演示样例文档：${name}\n`.padEnd(1000, '%')
  return Buffer.from(header + pad + '\n%%EOF\n', 'utf8')
}

/** 条目名 → (ext, mime, buffer)（方案 §4.2 映射） */
function sampleFor(reqName: string): { ext: string; mime: string; buf: Buffer } {
  if (/图|模型|程序/.test(reqName)) {
    return { ext: 'dwg', mime: 'application/acad', buf: sampleDwgBuffer(reqName) }
  }
  if (/清单|计划|记录|表/.test(reqName)) {
    return {
      ext: 'xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buf: sampleXlsxBuffer(reqName),
    }
  }
  return { ext: 'pdf', mime: 'application/pdf', buf: samplePdfBuffer(reqName) }
}

// ───────────────────────────── 推进算法（方案 §1.2）─────────────────────────────

type PhaseStatusLit = 'DONE' | 'IN_PROGRESS' | 'PAUSED' | 'NOT_STARTED'
interface PhasePlan {
  order: number
  status: PhaseStatusLit
  plannedStart: Date | null
  plannedEnd: Date | null
  actualStart: Date | null
  actualEnd: Date | null
  progress: number
}
interface PlanResult {
  phases: PhasePlan[]
  doneThrough: number
  inProgressAt: number | null
  pausedAt: number | null
  completedEnd: Date | null
}

function planPhases(status: string, signedAt: Date | null): PlanResult {
  if (status === 'ON_HOLD' || !signedAt) {
    // ON_HOLD（台账 signedAt 全 null）：售前已做，签约暂停
    const phases: PhasePlan[] = []
    for (let o = 1; o <= 20; o++) {
      if (o <= 2) {
        phases.push({ order: o, status: 'DONE', plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, progress: 100 })
      } else if (o === 3) {
        phases.push({ order: o, status: 'PAUSED', plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, progress: 0 })
      } else {
        phases.push({ order: o, status: 'NOT_STARTED', plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, progress: 0 })
      }
    }
    return { phases, doneThrough: 2, inProgressAt: null, pausedAt: 3, completedEnd: null }
  }

  const phases: PhasePlan[] = []
  let cursor = new Date(signedAt.getTime())
  let lastDone = 0

  if (status === 'COMPLETED') {
    for (let o = 1; o <= 20; o++) {
      const start = new Date(cursor.getTime())
      const end = addDays(cursor, DURATIONS[o])
      phases.push({ order: o, status: 'DONE', plannedStart: start, plannedEnd: end, actualStart: start, actualEnd: end, progress: 100 })
      cursor = end
      lastDone = o
    }
    return { phases, doneThrough: 20, inProgressAt: null, pausedAt: null, completedEnd: cursor }
  }

  // ACTIVE：排到 T0 为止
  const planDates: { start: Date; end: Date }[] = []
  let c = new Date(signedAt.getTime())
  for (let o = 1; o <= 20; o++) {
    const start = new Date(c.getTime())
    const end = addDays(c, DURATIONS[o])
    planDates.push({ start, end })
    c = end
  }
  for (let o = 1; o <= 20; o++) {
    const { start, end } = planDates[o - 1]
    if (end <= T0) {
      phases.push({ order: o, status: 'DONE', plannedStart: start, plannedEnd: end, actualStart: start, actualEnd: end, progress: 100 })
      cursor = end
      lastDone = o
    } else {
      break
    }
  }
  const inProgressAt = Math.min(lastDone + 1, 20)
  for (let o = lastDone + 1; o <= 20; o++) {
    const { start, end } = planDates[o - 1]
    if (o === inProgressAt && lastDone < 20) {
      const span = end.getTime() - start.getTime()
      const elapsed = T0.getTime() - start.getTime()
      const pct = span > 0 ? Math.round((elapsed / span) * 100) : 50
      phases.push({
        order: o,
        status: 'IN_PROGRESS',
        plannedStart: start,
        plannedEnd: end,
        actualStart: start,
        actualEnd: null,
        progress: Math.max(10, Math.min(90, pct)),
      })
    } else {
      phases.push({ order: o, status: 'NOT_STARTED', plannedStart: start, plannedEnd: end, actualStart: null, actualEnd: null, progress: 0 })
    }
  }
  return { phases, doneThrough: lastDone, inProgressAt: lastDone < 20 ? inProgressAt : null, pausedAt: null, completedEnd: null }
}

// ───────────────────────────── 全局上下文 ─────────────────────────────

interface DeliverableDef { name: string; required: boolean; purpose: string; scope: string }
interface StageDef { id: string; name: string; order: number; ownerJobTitle: string | null; deliverables: DeliverableDef[] }

interface Ctx {
  tpl20: { id: string; stages: StageDef[] }
  userIdByName: Map<string, string>
  userNameById: Map<string, string>
  adminId: string
  wangJianId: string
  yangQiongId: string
  history: HistoryFile
  now: Date
}

const stats = {
  projectsInstantiated: 0,
  projectsSkipped: 0,
  filesCreated: 0,
  notificationsCreated: 0,
  todosCreated: 0,
  messagesCreated: 0,
}

// ───────────────────────────── 成员配置（方案 §1.3）─────────────────────────────

type Tier = 'A' | 'B' | 'C'

function tierOf(record: HistoryRecord): Tier | null {
  if (record.status === 'ACTIVE') return 'A'
  if (record.status === 'ON_HOLD') return 'B'
  if (record.status === 'COMPLETED') return 'C'
  return null // CANCELLED 不实例化
}

interface MemberDef { userId: string; role: 'MANAGER' | 'MEMBER'; title: string }

function memberDefsFor(record: HistoryRecord, tier: Tier, ctx: Ctx): MemberDef[] {
  const u = (name: string): string => {
    const id = ctx.userIdByName.get(name)
    if (!id) throw new Error(`员工缺失：${name}（请先跑 db:seed）`)
    return id
  }
  // 项目经理按项目序号奇偶轮值（避免一人挂 60 项目）
  const seq = parseInt(record.code.replace(/\D/g, '').slice(-3), 10)
  const managerName = seq % 2 === 1 ? '吴月桐' : '徐见山'
  const defs: MemberDef[] = [
    { userId: u(managerName), role: 'MANAGER', title: '项目负责人' },
    { userId: u('周锦程'), role: 'MEMBER', title: '技术负责人' },
    { userId: u('孙若清'), role: 'MEMBER', title: '电气工程师' },
  ]
  if (tier === 'A') defs.push({ userId: u('马承志'), role: 'MEMBER', title: '电气工程师' })
  if (tier === 'A' || tier === 'C') {
    defs.push({ userId: u('胡云帆'), role: 'MEMBER', title: '工艺工程师' })
    defs.push({ userId: u('何雨桐'), role: 'MEMBER', title: '资料员' })
  }
  if (tier === 'B') {
    // B 档合计 5 人（方案 §0.2）：补资料员
    defs.push({ userId: u('何雨桐'), role: 'MEMBER', title: '资料员' })
  }
  defs.push({ userId: u('朱子安'), role: 'MEMBER', title: '商务经理' })
  if (tier === 'A') {
    defs.push({ userId: u('赵望舒'), role: 'MEMBER', title: '采购专员' })
    defs.push({ userId: u('杨景行'), role: 'MEMBER', title: '生产主管' })
  }
  return defs
}

// ───────────────────────────── 条目状态矩阵（方案 §1.5）─────────────────────────────

interface ReqSeed {
  stage: StageDef
  plan: PhasePlan
  d: DeliverableDef
  seq: number
  status: 'WAITING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NA'
  withFile: boolean
}

function reqSeedsFor(tier: Tier, plan: PlanResult, stages: StageDef[], rng: () => number): ReqSeed[] {
  const seeds: ReqSeed[] = []
  for (const stage of stages) {
    const pp = plan.phases[stage.order - 1]
    const deliverables = stage.deliverables ?? []
    let requiredIdx = 0
    deliverables.forEach((d, i) => {
      const seq = i + 1
      let status: ReqSeed['status'] = 'WAITING'
      let withFile = false
      if (pp.status === 'DONE') {
        if (d.required) {
          if (tier === 'A' && rng() < 0.1) {
            status = 'NA' // A 档 DONE 阶段 10% 随机 NA
          } else {
            status = 'APPROVED'
            withFile = true
          }
        } else {
          status = 'NA' // 非必需：A/C 档 NA 无实体；B 档 DONE 阶段无可选条目
        }
      } else if (pp.status === 'IN_PROGRESS' && tier === 'A') {
        if (d.required) {
          requiredIdx++
          if (requiredIdx === 1) { status = 'APPROVED'; withFile = true }
          else if (requiredIdx === 2) { status = 'SUBMITTED'; withFile = true }
          else if (requiredIdx === 3) { status = 'REJECTED'; withFile = true }
          else { status = 'WAITING' }
        } else {
          status = 'WAITING'
        }
      }
      // PAUSED / NOT_STARTED：全 WAITING，无实体
      seeds.push({ stage, plan: pp, d, seq, status, withFile })
      void requiredIdx
    })
  }
  return seeds
}

// ───────────────────────────── 通知/待办助手（方案 §2.1，幂等）─────────────────────────────

async function addNotification(
  data: { userId: string; type: string; title: string; body?: string | null; link?: string | null; isRead?: boolean; createdAt?: Date },
): Promise<boolean> {
  // 双保险幂等：(userId, type, link) 已存在即跳过
  const dup = await prisma.notification.findFirst({
    where: { userId: data.userId, type: data.type as never, link: data.link ?? null },
    select: { id: true },
  })
  if (dup) return false
  await prisma.notification.create({
    data: {
      userId: data.userId,
      type: data.type as never,
      title: data.title,
      body: data.body ?? null,
      link: data.link ?? null,
      isRead: data.isRead ?? false,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  })
  stats.notificationsCreated++
  return true
}

async function addTodo(
  data: { userId: string; title: string; sourceType: string; sourceId: string | null; link?: string | null; dueAt?: Date | null; priority?: string; doneAt?: Date | null },
): Promise<boolean> {
  // 幂等判据（同 ensureTaskTodo，sourceId 为 null 时按 title 查）
  const dup = data.sourceId
    ? await prisma.todoItem.findFirst({ where: { userId: data.userId, sourceType: data.sourceType as never, sourceId: data.sourceId }, select: { id: true } })
    : await prisma.todoItem.findFirst({ where: { userId: data.userId, title: data.title, sourceType: 'MANUAL' as never }, select: { id: true } })
  if (dup) return false
  await prisma.todoItem.create({
    data: {
      userId: data.userId,
      title: data.title,
      sourceType: data.sourceType as never,
      sourceId: data.sourceId,
      link: data.link ?? null,
      dueAt: data.dueAt ?? null,
      priority: (data.priority ?? 'MEDIUM') as never,
      doneAt: data.doneAt ?? null,
    },
  })
  stats.todosCreated++
  return true
}

// ───────────────────────────── 并发池（写盘并发 8，方案 §4.3）─────────────────────────────

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}

// ───────────────────────────── 单项目实例化（方案 §5.3）─────────────────────────────

interface ProjectOutcome {
  code: string
  result: string
}

async function instantiateOne(record: HistoryRecord, ctx: Ctx): Promise<ProjectOutcome> {
  const tier = tierOf(record)
  if (!tier) return { code: record.code, result: '跳过（作废档 CANCELLED）' }

  const project = await prisma.project.findUnique({ where: { code: record.code } })
  if (!project) return { code: record.code, result: '跳过（Project 档案不存在，请先跑 db:seed）' }

  // ★ 项目级幂等：已实例化则整体跳过
  const phaseCount = await prisma.phase.count({ where: { projectId: project.id } })
  if (phaseCount > 0) return { code: record.code, result: '跳过（已实例化，phase>0）' }

  const rng = mulberry32(hashStr(record.code))
  const signedAt = record.signedAt ? new Date(record.signedAt) : null
  const plan = planPhases(record.status, signedAt)
  const members = memberDefsFor(record, tier, ctx)
  const managerId = members[0].userId
  const managerName = ctx.userNameById.get(managerId) ?? '项目经理'
  const reqSeeds = reqSeedsFor(tier, plan, ctx.tpl20.stages, rng)

  // ── 事务块（原子：阶段/成员/目录/条目/会话骨架）──
  const txResult = await prisma.$transaction(async (tx) => {
    // 1. Phase
    const phaseIdByOrder = new Map<number, string>()
    const ownerIdByOrder = new Map<number, string | null>()
    for (const stage of ctx.tpl20.stages) {
      const pp = plan.phases[stage.order - 1]
      const owner = stage.ownerJobTitle ? await matchOwnerForJobTitle(tx, stage.ownerJobTitle) : null
      ownerIdByOrder.set(stage.order, owner?.id ?? null)
      const ph = await tx.phase.create({
        data: {
          projectId: project.id,
          code: phaseCodeOf(stage.order),
          name: stage.name,
          order: stage.order,
          status: pp.status as never,
          ownerId: owner?.id ?? null,
          plannedStart: pp.plannedStart,
          plannedEnd: pp.plannedEnd,
          actualStart: pp.actualStart,
          actualEnd: pp.actualEnd,
          progress: pp.progress,
        },
      })
      phaseIdByOrder.set(stage.order, ph.id)
    }

    // 2. ProjectMember（upsert @@unique(projectId,userId)）
    for (const m of members) {
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: m.userId } },
        update: {},
        create: { projectId: project.id, userId: m.userId, role: m.role, title: m.title },
      })
    }

    // 3. FileCatalog + FileRequirement（幂等：catalog 按 projectId+phaseCode 复用）
    const reqIds: { seed: ReqSeed; reqId: string }[] = []
    for (const stage of ctx.tpl20.stages) {
      if (!stage.deliverables?.length) continue
      const code = phaseCodeOf(stage.order)
      let catalog = await tx.fileCatalog.findFirst({ where: { projectId: project.id, phaseCode: code } })
      if (!catalog) {
        catalog = await tx.fileCatalog.create({
          data: {
            projectId: project.id,
            name: `${String(stage.order).padStart(2, '0')}-${stage.name}`,
            phaseCode: code,
            order: stage.order,
          },
        })
      }
      const phaseOwnerId = ownerIdByOrder.get(stage.order) ?? null
      const pp = plan.phases[stage.order - 1]
      for (const seed of reqSeeds.filter((s) => s.stage.order === stage.order)) {
        const req = await tx.fileRequirement.create({
          data: {
            projectId: project.id,
            catalogId: catalog.id,
            phaseCode: code,
            name: seed.d.name,
            code: `PROJ-${code}-E-${String(seed.seq).padStart(3, '0')}`,
            required: seed.d.required,
            ownerId: phaseOwnerId,
            purpose: seed.d.purpose ?? null,
            scope: (seed.d.scope ?? 'PUBLIC') as never,
            status: seed.status,
            reviewerId: seed.status === 'WAITING' || seed.status === 'NA' ? null : ctx.wangJianId,
            dueDate: pp.plannedEnd ?? null,
          },
        })
        reqIds.push({ seed, reqId: req.id })
      }
    }

    // 4. A/B 档：会话骨架（PROJECT_GROUP + 成员 + SYSTEM 欢迎消息）
    let convId: string | null = null
    if (tier === 'A' || tier === 'B') {
      let conv = await tx.conversation.findFirst({ where: { projectId: project.id, type: 'PROJECT_GROUP' } })
      if (!conv) {
        const shortName = record.name.slice(0, 6)
        conv = await tx.conversation.create({
          data: {
            type: 'PROJECT_GROUP',
            name: tier === 'A' ? `${record.code} ${shortName}项目群` : `${record.code} 售前跟进群`,
            projectId: project.id,
            createdBy: managerId,
          },
        })
        for (const m of members) {
          await tx.conversationMember.create({
            data: {
              conversationId: conv.id,
              userId: m.userId,
              role: m.userId === managerId ? 'OWNER' : 'MEMBER',
            },
          })
        }
        const names = members.map((m) => ctx.userNameById.get(m.userId) ?? '').join('、')
        await tx.message.create({
          data: {
            conversationId: conv.id,
            senderId: managerId,
            type: 'SYSTEM',
            content: `项目群已创建，成员：${names}`,
            createdAt: new Date(ctx.now.getTime() - 540 * 60 * 1000),
          },
        })
      }
      convId = conv.id
    }

    // 5. C 档：回填 Project.actualEnd/plannedEnd；A 档绑定模板
    if (tier === 'C' && plan.completedEnd) {
      await tx.project.update({
        where: { id: project.id },
        data: { actualEnd: plan.completedEnd, plannedEnd: plan.completedEnd },
      })
    }
    await tx.project.update({ where: { id: project.id }, data: { templateId: ctx.tpl20.id } })

    return { phaseIdByOrder, ownerIdByOrder, reqIds, convId }
  })

  if (DRY_RUN) return { code: record.code, result: `（dry-run）${tier} 档` }

  const { phaseIdByOrder, ownerIdByOrder, reqIds, convId } = txResult

  // ── 事务外 6：File 实体（幂等：按 requirementId 查重；铁律：不建无实体的 File 记录）──
  const fileJobs = reqIds.filter(({ seed }) => seed.withFile)
  await pool(fileJobs, 8, async ({ seed, reqId }) => {
    const existing = await prisma.file.findFirst({ where: { requirementId: reqId }, select: { id: true } })
    if (existing) return
    const { ext, mime, buf } = sampleFor(seed.d.name)
    const catalog = await prisma.fileCatalog.findFirst({
      where: { projectId: project.id, phaseCode: phaseCodeOf(seed.stage.order) },
      select: { id: true },
    })
    if (!catalog) return
    const { storagePath, size } = await writeUploadFile(project.id, catalog.id, `${seed.d.name}.${ext}`, mime, buf)
    const uploadedById = seed.plan && ownerIdByOrder.get(seed.stage.order) ? (ownerIdByOrder.get(seed.stage.order) as string) : managerId
    const file = await prisma.file.create({
      data: {
        requirementId: reqId,
        projectId: project.id,
        name: `${seed.d.name} v1.0`,
        originalName: `${seed.d.name}.${ext}`,
        storagePath,
        size,
        mimeType: mime,
        checksum: sha256(buf),
        version: 1,
        uploadedById,
      },
    })
    await prisma.fileAccessLog.create({ data: { fileId: file.id, userId: uploadedById, action: 'UPLOAD' } })
    stats.filesCreated++
  })

  // ── 事务外 7：A 档任务 + 修订 + 标注 + 评论（方案 §1.6）──
  const issueVariant = hashStr(record.code) % 2 === 1 // REPORT/ISSUE 轮替
  let task1: { id: string; title: string } | null = null
  let currentStageName = ''
  if (tier === 'A') {
    const inProgressOrder = plan.inProgressAt ?? plan.doneThrough
    const curStage = ctx.tpl20.stages[inProgressOrder - 1]
    currentStageName = curStage.name
    const curDeliverables = curStage.deliverables ?? []
    const d1 = curDeliverables[0]?.name ?? '交付物'
    const d2 = curDeliverables[1]?.name ?? d1
    const phaseOwnerId = ownerIdByOrder.get(inProgressOrder) ?? null
    const phaseId = phaseIdByOrder.get(inProgressOrder)!
    const day = 24 * 3600 * 1000
    const nowMs = ctx.now.getTime()

    // 幂等：本项目已有任务则跳过（任务只在首次实例化建）
    const taskCount = await prisma.task.count({ where: { projectId: project.id } })
    if (taskCount === 0) {
      const t1 = await prisma.task.create({
        data: {
          phaseId, projectId: project.id,
          title: `${curStage.name}·${d1}`,
          status: 'IN_PROGRESS', priority: 'HIGH',
          assigneeId: phaseOwnerId ?? managerId, creatorId: managerId,
          dueDate: new Date(nowMs + 3 * day), startedAt: new Date(nowMs - 2 * day),
        },
      })
      task1 = { id: t1.id, title: t1.title }
      const t2 = await prisma.task.create({
        data: {
          phaseId, projectId: project.id,
          title: `${curStage.name}·${d2}`,
          status: 'TODO', priority: 'MEDIUM',
          assigneeId: phaseOwnerId ?? managerId, creatorId: managerId,
          dueDate: new Date(nowMs + 7 * day),
        },
      })
      const t3 = await prisma.task.create({
        data: {
          phaseId, projectId: project.id,
          title: `${curStage.name}·复核与提交`,
          status: 'REVIEW', priority: 'MEDIUM',
          assigneeId: managerId, creatorId: managerId,
          dueDate: new Date(nowMs + 5 * day),
          revision: 2,
        },
      })
      // 任务 4：上一 DONE 阶段归档（何雨桐）
      const prevDoneOrder = Math.max(plan.doneThrough, 1)
      const prevStage = ctx.tpl20.stages[prevDoneOrder - 1]
      const prevPhase = plan.phases[prevDoneOrder - 1]
      const arcStart = prevPhase.actualStart ?? prevPhase.plannedStart ?? new Date(nowMs - 10 * day)
      const arcEnd = prevPhase.actualEnd ?? addDays(arcStart, 1)
      await prisma.task.create({
        data: {
          phaseId: phaseIdByOrder.get(prevDoneOrder)!, projectId: project.id,
          title: `${prevStage.name}·资料归档`,
          status: 'DONE', priority: 'MEDIUM',
          assigneeId: ctx.yangQiongId, creatorId: managerId,
          startedAt: arcStart, completedAt: arcEnd,
        },
      })
      // 修订历史（任务3 v1→v2）
      await prisma.taskRevision.create({
        data: {
          taskId: t3.id, version: 2,
          changeSummary: '按客户意见调整参数',
          changedById: ctx.wangJianId,
          snapshot: { title: t3.title, status: 'REVIEW', assigneeId: managerId, revision: 1 },
        },
      })
      // 标注（任务2）
      await prisma.annotation.create({
        data: { taskId: t2.id, userId: managerId, field: null, color: 'red', note: '与客户确认后更新', resolved: false },
      })
      // 评论（任务1/2，含 @）
      await prisma.comment.create({
        data: { taskId: t1.id, userId: managerId, content: `@${ctx.userNameById.get(phaseOwnerId ?? managerId)} ${d1} 进度如何？客户在等。`, mentions: [phaseOwnerId ?? managerId] },
      })
      await prisma.comment.create({
        data: { taskId: t1.id, userId: phaseOwnerId ?? ctx.wangJianId, content: '初稿已完成，今天下班前提交审核。' },
      })
      await prisma.comment.create({
        data: { taskId: t2.id, userId: ctx.wangJianId, content: `${d2} 我先预审一遍，有问题群里说。` },
      })
    } else {
      const t = await prisma.task.findFirst({ where: { projectId: project.id, status: 'IN_PROGRESS' }, orderBy: { dueDate: 'asc' } })
      task1 = t ? { id: t.id, title: t.title } : null
    }
  }

  // ── 事务外 8：群消息（A 10 条 / B 3 条；幂等：message.count>1 跳过）──
  if (convId && (tier === 'A' || tier === 'B')) {
    const msgCount = await prisma.message.count({ where: { conversationId: convId } })
    if (msgCount <= 1) {
      const minute = 60 * 1000
      const offsets = [480, 420, 360, 300, 240, 180, 120, 90, 45, 10] // 方案 §3.2
      const stageOwnerId = ownerIdByOrder.get(plan.inProgressAt ?? plan.doneThrough) ?? null
      const ownerName = stageOwnerId ? ctx.userNameById.get(stageOwnerId) ?? '' : managerName
      const curStage = ctx.tpl20.stages[(plan.inProgressAt ?? plan.doneThrough) - 1]
      const d1 = curStage?.deliverables?.[0]?.name ?? '资料'
      const d2 = curStage?.deliverables?.[1]?.name ?? d1

      const msgs: { senderId: string; type: string; content: string; mentions?: string[] }[] = []
      if (tier === 'A') {
        msgs.push(
          { senderId: managerId, type: 'TEXT', content: `${record.code} 已启动，当前推进到「${currentStageName}」，注意节点。` },
          { senderId: stageOwnerId ?? managerId, type: 'TEXT', content: `收到，${d1} 初稿已完成，待审核。` },
          { senderId: ctx.yangQiongId, type: 'TEXT', content: '相关资料已归档到文件目录。' },
          { senderId: managerId, type: 'TEXT', content: `@${ownerName} ${d2} 本周内提交一下。`, mentions: stageOwnerId ? [stageOwnerId] : [] },
          { senderId: stageOwnerId ?? managerId, type: 'TEXT', content: '好的，正在整理。' },
          { senderId: ctx.userIdByName.get('朱子安')!, type: 'TEXT', content: `客户催进度了，${currentStageName} 要抓紧。` },
        )
        if (task1) {
          msgs.push({ senderId: managerId, type: 'TASK_CARD', content: JSON.stringify({ taskId: task1.id, taskTitle: task1.title }) })
        } else {
          msgs.push({ senderId: managerId, type: 'TEXT', content: '任务卡稍后同步到群里。' })
        }
        if (issueVariant) {
          msgs.push({
            senderId: stageOwnerId ?? managerId, type: 'ISSUE',
            content: JSON.stringify({ title: `${currentStageName}物料到货延迟`, severity: 'medium', status: 'open', description: `供应商反馈 ${d1} 相关物料延迟 3 天到货，需要协调。` }),
          })
        } else {
          msgs.push({
            senderId: managerId, type: 'REPORT',
            content: JSON.stringify({ kind: 'daily', date: '2025-09-06', summary: `今日推进${currentStageName}：${d1} 初稿完成，${d2} 整理中。`, nextPlan: `明日提交 ${d2}，跟进物料到货。` }),
          })
        }
        msgs.push({ senderId: ctx.wangJianId, type: 'TEXT', content: '我来协调资源。' })
      } else {
        // B 档售前群：欢迎 + 2 条
        msgs.push(
          { senderId: managerId, type: 'TEXT', content: `${record.code} 售前跟进中，方案与报价待客户确认。` },
          { senderId: ctx.userIdByName.get('朱子安')!, type: 'TEXT', content: '客户侧有反馈我第一时间同步。' },
        )
      }

      let lastAt = ctx.now
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        const at = new Date(ctx.now.getTime() - (offsets[i] ?? 10) * minute)
        await prisma.message.create({
          data: {
            conversationId: convId,
            senderId: m.senderId,
            type: m.type as never,
            content: m.content,
            ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
            createdAt: at,
          },
        })
        stats.messagesCreated++
        lastAt = at
      }
      await prisma.conversation.update({ where: { id: convId }, data: { lastMessageAt: lastAt } })

      // 未读角标控制（方案 §3.3）：随机 2 名成员 lastReadAt=now-120min，其余交错 null/now
      const convMembers = await prisma.conversationMember.findMany({ where: { conversationId: convId } })
      const partiallyRead = new Set<string>()
      for (let k = 0; k < Math.min(2, convMembers.length); k++) {
        partiallyRead.add(convMembers[Math.floor(rng() * convMembers.length)].id)
      }
      let flip = false
      for (const cm of convMembers) {
        if (partiallyRead.has(cm.id)) {
          await prisma.conversationMember.update({ where: { id: cm.id }, data: { lastReadAt: new Date(ctx.now.getTime() - 120 * minute) } })
        } else {
          await prisma.conversationMember.update({ where: { id: cm.id }, data: { lastReadAt: flip ? ctx.now : null } })
          flip = !flip
        }
      }
    }
  }

  // ── 事务外 9：A 档通知 + 待办（方案 §2.1/§2.2，通知 60% 概率落库、isRead 40% 已读）──
  if (tier === 'A') {
    const day = 24 * 3600 * 1000
    const nowMs = ctx.now.getTime()
    const curOrder = plan.inProgressAt ?? plan.doneThrough
    const curReqs = reqIds.filter(({ seed }) => seed.stage.order === curOrder)
    const submitted = curReqs.find(({ seed }) => seed.status === 'SUBMITTED')
    const rejected = curReqs.find(({ seed }) => seed.status === 'REJECTED')
    const approved = curReqs.find(({ seed }) => seed.status === 'APPROVED')
    const waitingRequired = curReqs.filter(({ seed }) => seed.status === 'WAITING' && seed.d.required)
    const tasks = await prisma.task.findMany({ where: { projectId: project.id, status: { not: 'DONE' } }, orderBy: { dueDate: 'asc' } })
    const inProgressOrder = plan.inProgressAt ?? plan.doneThrough
    const phaseOwnerId = ownerIdByOrder.get(inProgressOrder) ?? null

    const keep = () => rng() < 0.6
    const read = () => rng() < 0.4

    // 任务指派 ×3（未完成任务，TASK_ASSIGNED → 任务待办）
    for (const t of tasks.slice(0, 3)) {
      if (!t.assigneeId) continue
      const link = `/projects/${project.id}/tasks?taskId=${t.id}`
      if (keep()) {
        await addNotification({ userId: t.assigneeId, type: 'TASK_ASSIGNED', title: `任务已指派给你：${t.title}`, body: `项目内任务「${t.title}」指派给你，请及时处理`, link, isRead: read() })
      }
      await addTodo({ userId: t.assigneeId, title: `任务待办：${t.title}`, sourceType: 'TASK', sourceId: t.id, link, dueAt: t.dueDate, priority: t.priority })
    }
    // 提交待审 ×1（SUBMITTED → 周锦程）
    if (submitted) {
      const link = `/projects/${project.id}/files?requirementId=${submitted.reqId}`
      const reqName = submitted.seed.d.name
      if (keep()) {
        await addNotification({ userId: ctx.wangJianId, type: 'FILE_PENDING_REVIEW', title: `文件待审核：${reqName}`, body: `${reqName} 已提交第 v1 版，请审核`, link, isRead: read() })
      }
    }
    // 文件催办 ×2（WAITING 必需条目：一条临期 now+2d、一条逾期 now-1d）
    for (let i = 0; i < Math.min(2, waitingRequired.length); i++) {
      const w = waitingRequired[i]
      const overdue = i === 1
      const dueAt = overdue ? new Date(nowMs - 1 * day) : new Date(nowMs + 2 * day)
      const link = `/projects/${project.id}/files?requirementId=${w.reqId}`
      const reqName = w.seed.d.name
      const body = overdue
        ? `「${reqName}」已逾期，请尽快提交`
        : `「${reqName}」即将到期，请及时提交`
      const ownerId = w.seed && phaseOwnerId ? phaseOwnerId : managerId
      if (keep()) {
        await addNotification({ userId: ownerId, type: 'FILE_DUE_SOON', title: `文件催办：${reqName}`, body, link, isRead: read() })
      }
      await addTodo({ userId: ownerId, title: `【催办】${reqName}`, sourceType: 'FILE_REQ', sourceId: w.reqId, link, dueAt, priority: overdue ? 'HIGH' : 'MEDIUM' })
      // dueDate 同步为催办口径（供逾期判断演示）
      await prisma.fileRequirement.update({ where: { id: w.reqId }, data: { dueDate: dueAt } })
    }
    // 审核通过 ×1
    if (approved) {
      const reqName = approved.seed.d.name
      if (keep()) {
        await addNotification({
          userId: phaseOwnerId ?? managerId, type: 'FILE_APPROVED',
          title: `文件已通过审核：${reqName}`, body: '审核意见：符合要求，归档',
          link: `/projects/${project.id}/files?requirementId=${approved.reqId}`, isRead: read(),
        })
      }
    }
    // 审核驳回 ×1（通知给 ownerId + 重新提交待办）
    if (rejected) {
      const reqName = rejected.seed.d.name
      const ownerId = phaseOwnerId ?? managerId
      const link = `/projects/${project.id}/files?requirementId=${rejected.reqId}`
      if (keep()) {
        await addNotification({ userId: ownerId, type: 'FILE_PENDING_REVIEW', title: `文件被驳回：${reqName}`, body: '驳回意见：参数需与客户确认，请修改后重新提交', link, isRead: read() })
      }
      await addTodo({ userId: ownerId, title: `【催办】${reqName}`, sourceType: 'FILE_REQ', sourceId: rejected.reqId, link, dueAt: new Date(nowMs + 2 * day), priority: 'HIGH' })
    }
    // @提及 ×1（MENTION 通知 + MESSAGE 待办）
    if (convId && phaseOwnerId) {
      const mentionMsg = await prisma.message.findFirst({
        where: { conversationId: convId, mentions: { not: Prisma.DbNull } },
        orderBy: { createdAt: 'desc' },
      })
      if (mentionMsg) {
        const link = `/messages?conversation=${convId}`
        if (keep()) {
          await addNotification({ userId: phaseOwnerId, type: 'MENTION', title: `${managerName} 在群聊中提到了你`, body: null, link, isRead: read() })
        }
        await addTodo({ userId: phaseOwnerId, title: `群聊@待处理：${record.code} ${currentStageName}`, sourceType: 'MESSAGE', sourceId: mentionMsg.id, link, dueAt: null, priority: 'MEDIUM' })
      }
    }
    // 日报/问题上报 ×1（与消息 9 号轮替一致）
    if (convId) {
      const special = await prisma.message.findFirst({
        where: { conversationId: convId, type: issueVariant ? 'ISSUE' : 'REPORT' },
        orderBy: { createdAt: 'desc' },
      })
      if (special) {
        if (issueVariant) {
          const parsed = JSON.parse(special.content) as { title?: string }
          await addNotification({ userId: managerId, type: 'ISSUE_NEW', title: parsed.title ?? '新问题上报', body: null, link: `/messages?conversation=${convId}`, isRead: read() })
          await addTodo({ userId: managerId, title: `问题跟进：${parsed.title ?? '物料延迟'}`, sourceType: 'ISSUE', sourceId: special.id, link: `/messages?conversation=${convId}`, dueAt: new Date(nowMs + 2 * day), priority: 'HIGH' })
        } else {
          await addNotification({ userId: managerId, type: 'REPORT_NEW', title: `新日报待查阅：${record.code}`, body: null, link: `/messages?conversation=${convId}`, isRead: read() })
          await addTodo({ userId: managerId, title: `日报待查阅：${record.code} 2025-09-06`, sourceType: 'REPORT', sourceId: special.id, link: `/messages?conversation=${convId}`, dueAt: null, priority: 'MEDIUM' })
        }
      }
    }
  }

  // B 档：SYSTEM 欢迎通知（每成员 1 条）
  if (tier === 'B' && convId) {
    for (const m of members) {
      await addNotification({
        userId: m.userId, type: 'SYSTEM',
        title: `欢迎加入 ${record.code} 售前跟进群`, body: null,
        link: `/messages?conversation=${convId}`, isRead: false,
      })
    }
  }

  // ── 事务外 10：ActivityLog ──
  const hasLog = await prisma.activityLog.findFirst({ where: { projectId: project.id, action: 'project.instantiate' }, select: { id: true } })
  if (!hasLog) {
    await prisma.activityLog.create({
      data: { projectId: project.id, userId: ctx.adminId, action: 'project.instantiate', detail: { source: 'seed-demo-data', stages: 20 } },
    })
  }

  stats.projectsInstantiated++
  return { code: record.code, result: `${tier} 档实例化完成（DONE ${plan.doneThrough}/20${plan.inProgressAt ? `，IN_PROGRESS PH${String(plan.inProgressAt).padStart(2, '0')}` : ''}${plan.pausedAt ? '，PH03 PAUSED' : ''}）` }
}

// ───────────────────────────── 全局协作数据（方案 §5.2 步骤2）─────────────────────────────

async function seedSingleChats(ctx: Ctx): Promise<void> {
  const pairs: { a: string; b: string; msgs: { from: 0 | 1; text: string }[] }[] = [
    {
      a: '吴月桐', b: '孙若清',
      msgs: [
        { from: 0, text: '孙工，DEMO25017 电气原理图审核意见看了吗？' },
        { from: 1, text: '看了，变频器品牌那一条我今天改。' },
        { from: 0, text: '好，改完直接提交，周锦程那边我打过招呼了。' },
        { from: 1, text: '收到。另外元件清单里有几个型号缺货，我找赵望舒确认替代。' },
        { from: 0, text: '可以，替代型号要走技术确认流程。' },
        { from: 1, text: '明白，走流程。' },
      ],
    },
    {
      a: '朱子安', b: '周锦程',
      msgs: [
        { from: 0, text: '王工，DEMO25022 客户想要一份技术方案对外版。' },
        { from: 1, text: '对外版我整理一下，下午给你。' },
        { from: 0, text: '辛苦，报价部分记得去掉成本明细。' },
        { from: 1, text: '放心，只留客户报价。' },
        { from: 0, text: '好的，客户那边我约周三。' },
      ],
    },
  ]
  const minute = 60 * 1000
  for (const pair of pairs) {
    const uidA = ctx.userIdByName.get(pair.a)
    const uidB = ctx.userIdByName.get(pair.b)
    if (!uidA || !uidB) continue
    // 幂等：type=SINGLE 且成员集合={两人}
    const existing = await prisma.conversation.findMany({ where: { type: 'SINGLE' }, include: { members: true } })
    let conv = existing.find((c) => {
      const ids = c.members.map((m) => m.userId)
      return ids.length === 2 && ids.includes(uidA) && ids.includes(uidB)
    })
    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          type: 'SINGLE', name: null, createdBy: uidA,
          members: { create: [{ userId: uidA, role: 'MEMBER' }, { userId: uidB, role: 'MEMBER' }] },
        },
        include: { members: true },
      })
    }
    const msgCount = await prisma.message.count({ where: { conversationId: conv.id } })
    if (msgCount > 0) continue
    let lastAt = ctx.now
    for (let i = 0; i < pair.msgs.length; i++) {
      const m = pair.msgs[i]
      const at = new Date(ctx.now.getTime() - (pair.msgs.length - i) * 35 * minute)
      await prisma.message.create({
        data: { conversationId: conv.id, senderId: m.from === 0 ? uidA : uidB, type: 'TEXT', content: m.text, createdAt: at },
      })
      stats.messagesCreated++
      lastAt = at
    }
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: lastAt } })
    // 未读角标：一方 lastReadAt=now-30min
    const cmA = conv.members.find((m) => m.userId === uidA)
    if (cmA) await prisma.conversationMember.update({ where: { id: cmA.id }, data: { lastReadAt: new Date(ctx.now.getTime() - 30 * minute) } })
  }
}

async function seedManualTodos(ctx: Ctx): Promise<void> {
  const day = 24 * 3600 * 1000
  const nowMs = ctx.now.getTime()
  const defs: { name: string; title: string; dueAt: Date; priority: string }[] = [
    { name: '黄北辰', title: '整理 9 月经营例会项目进度汇报材料', dueAt: new Date(nowMs + 2 * day), priority: 'HIGH' },
    { name: '高慕白', title: '核对 DEMO25017/25022 两项目尾款到账情况', dueAt: new Date(nowMs + 1 * day), priority: 'HIGH' },
    { name: '郭南峰', title: '更新通讯录：售后部人员到岗确认', dueAt: new Date(nowMs + 5 * day), priority: 'MEDIUM' },
    { name: '张恒宇', title: '完善个人岗位信息（联系人事确认职责）', dueAt: new Date(nowMs + 7 * day), priority: 'LOW' },
    { name: '黄北辰', title: '归档会议室投影仪借用登记', dueAt: new Date(nowMs - 1 * day), priority: 'LOW' },
    { name: '吴月桐', title: '确认 DEMO25031 启动会时间', dueAt: new Date(nowMs + 1 * day), priority: 'URGENT' },
    // 覆盖补充（方案 §2.2 覆盖验证：distinct userId ≥18，全部非 ADMIN）
    { name: '马承志', title: '整理 DEMO25024 电柜线束表制图规范', dueAt: new Date(nowMs + 3 * day), priority: 'MEDIUM' },
    { name: '何雨桐', title: '2025 上半年已完结项目竣工资料整理归档', dueAt: new Date(nowMs + 6 * day), priority: 'MEDIUM' },
    { name: '朱子安', title: '跟进 DEMO25028 海外意向项目签约进展', dueAt: new Date(nowMs + 4 * day), priority: 'MEDIUM' },
    { name: '李书瑶', title: '编制容器设计通用件清单', dueAt: new Date(nowMs + 5 * day), priority: 'LOW' },
    { name: '王砚洲', title: '汇报示例制造车间本周生产进度', dueAt: new Date(nowMs + 1 * day), priority: 'HIGH' },
    { name: '刘牧原', title: '盘点车间常用工具库存', dueAt: new Date(nowMs + 8 * day), priority: 'LOW' },
    { name: '罗向谦', title: '确认生产计划外协加工排期', dueAt: new Date(nowMs + 2 * day), priority: 'MEDIUM' },
  ]
  for (const d of defs) {
    const userId = ctx.userIdByName.get(d.name)
    if (!userId) continue
    await addTodo({ userId, title: d.title, sourceType: 'MANUAL', sourceId: null, link: null, dueAt: d.dueAt, priority: d.priority })
  }
}

// ───────────────────────────── 待办 30% 随机已完成（方案 §2.2，确定性 hash）─────────────────────────────

async function finalizeTodoDone(): Promise<void> {
  const todos = await prisma.todoItem.findMany({
    where: { sourceType: { not: 'MANUAL' }, doneAt: null },
    select: { id: true, createdAt: true },
  })
  for (const t of todos) {
    if (hashStr(t.id) % 10 < 3) {
      await prisma.todoItem.update({ where: { id: t.id }, data: { doneAt: new Date(t.createdAt.getTime() + 2 * 3600 * 1000) } })
    }
  }
}

// ───────────────────────────── 全员 SYSTEM 通知（方案 §5.2 步骤2，幂等）─────────────────────────────

async function seedSystemNotice(ctx: Ctx): Promise<void> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } })
  for (const u of users) {
    await addNotification({
      userId: u.id, type: 'SYSTEM',
      title: '系统试运行，欢迎反馈',
      body: 'PM 项目管理系统试运行期间，问题请联系管理员',
      link: null, isRead: false,
    })
  }
}

// ───────────────────────────── 坏链自查（方案 §6.1 收尾；旧假记录单独计数，见附录3）─────────────────────────────

async function checkBrokenLinks(): Promise<{ total: number; missingNew: number; legacyFake: number }> {
  const files = await prisma.file.findMany({ select: { id: true, storagePath: true } })
  let missingNew = 0
  let legacyFake = 0
  for (const f of files) {
    const abs = resolveStoredFile(f.storagePath)
    if (!abs || !existsSync(abs)) {
      if (f.storagePath.startsWith('/files/')) legacyFake++ // db:seed 旧版遗留假记录（脚本不背锅，不删）
      else missingNew++
    }
  }
  return { total: files.length, missingNew, legacyFake }
}

// ───────────────────────────── pg_notify（--with-notify，方案 §3.4）─────────────────────────────

async function pushImEvents(): Promise<void> {
  const convs = await prisma.conversation.findMany({ select: { id: true, type: true, name: true } })
  for (const c of convs) {
    await prisma.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'conv:created',
      conversation: { id: c.id, type: c.type, name: c.name },
    })})`
  }
}

// ───────────────────────────── main（方案 §5.2）─────────────────────────────

const COUNT_TABLES = [
  'phase', 'projectMember', 'fileCatalog', 'fileRequirement', 'file', 'fileAccessLog',
  'task', 'taskRevision', 'annotation', 'comment', 'conversation', 'conversationMember',
  'message', 'notification', 'todoItem', 'activityLog',
] as const

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of COUNT_TABLES) {
    out[t] = await (prisma[t] as { count: () => Promise<number> }).count()
  }
  return out
}

async function main() {
  const startedAt = Date.now()
  console.log(`[seed-demo-data] ${DRY_RUN ? 'DRY-RUN 模式（不落库）' : '正式执行'}，T0=${T0.toISOString().slice(0, 10)}`)

  // ── 0. 前置加载 ──
  const tpl = await prisma.processTemplate.findFirst({
    where: { isDefault: true },
    include: { stages: { orderBy: { order: 'asc' } } },
  })
  const users = await prisma.user.findMany({ where: { isActive: true } })
  const history = JSON.parse(readFileSync(join(DATA_DIR, 'historical-projects-2024-2025.json'), 'utf8')) as HistoryFile

  if (!tpl || tpl.stages.length !== 20) {
    throw new Error('默认流程模板缺失或阶段数≠20，请先跑 npm run db:seed')
  }
  if (users.length !== 51) {
    throw new Error(`在职用户数=${users.length}≠51，请先跑 npm run db:seed`)
  }
  const stages: StageDef[] = tpl.stages.map((s) => ({
    id: s.id,
    name: s.name,
    order: s.order,
    ownerJobTitle: s.ownerJobTitle,
    deliverables: Array.isArray(s.deliverables) ? (s.deliverables as unknown as DeliverableDef[]) : [],
  }))
  const userIdByName = new Map(users.map((u) => [u.name, u.id]))
  const userNameById = new Map(users.map((u) => [u.id, u.name]))
  const adminId = userIdByName.get('陈牧之')
  const wangJianId = userIdByName.get('周锦程')
  const yangQiongId = userIdByName.get('何雨桐')
  if (!adminId || !wangJianId || !yangQiongId) throw new Error('关键账号缺失（陈牧之/周锦程/何雨桐），请先跑 db:seed')

  const ctx: Ctx = {
    tpl20: { id: tpl.id, stages },
    userIdByName, userNameById, adminId, wangJianId, yangQiongId,
    history, now: new Date(),
  }

  const before = await counts()

  // ── 1. 遍历 64 项目按档实例化 ──
  const records = [...history.projects].sort((a, b) => a.code.localeCompare(b.code))
  let i = 0
  for (const record of records) {
    i++
    if (ONLY && !ONLY.has(record.code)) continue
    if (record.demoEnriched) {
      console.log(`[${i}/${records.length}] ${record.code} 跳过（demoEnriched，db:seed 已深度实例化）`)
      stats.projectsSkipped++
      continue
    }
    if (record.status === 'CANCELLED') {
      console.log(`[${i}/${records.length}] ${record.code} 跳过（作废档）`)
      stats.projectsSkipped++
      continue
    }
    if (DRY_RUN) {
      const plan = planPhases(record.status, record.signedAt ? new Date(record.signedAt) : null)
      const tier = tierOf(record)!
      console.log(`[${i}/${records.length}] ${record.code} [${tier}档] 计划：DONE ${plan.doneThrough}/20${plan.inProgressAt ? ` IN_PROGRESS PH${String(plan.inProgressAt).padStart(2, '0')}` : ''}${plan.pausedAt ? ' PH03 PAUSED' : ''}，成员 ${memberDefsFor(record, tier, ctx).length} 人，条目 ${reqSeedsFor(tier, plan, stages, mulberry32(hashStr(record.code))).filter((s) => s.withFile).length} 文件`)
      continue
    }
    const outcome = await instantiateOne(record, ctx)
    console.log(`[${i}/${records.length}] ${outcome.code} → ${outcome.result}`)
  }

  // ── 2. 全局协作数据 ──
  if (!DRY_RUN && !ONLY) {
    await seedSingleChats(ctx)
    await seedManualTodos(ctx)
    await finalizeTodoDone()
    await seedSystemNotice(ctx)
    if (WITH_NOTIFY) await pushImEvents()
  }

  // ── 3. 汇总打印 ──
  const after = await counts()
  console.log('\n═══════ 填充汇总 ═══════')
  console.log(`项目实例化：${stats.projectsInstantiated}，跳过：${stats.projectsSkipped}`)
  for (const t of COUNT_TABLES) {
    const delta = after[t] - before[t]
    console.log(`  ${t.padEnd(20)} ${String(before[t]).padStart(6)} → ${String(after[t]).padStart(6)}  (+${delta})`)
  }
  const broken = await checkBrokenLinks()
  console.log(`坏链自查：File 总数=${broken.total}，本脚本新增 missing=${broken.missingNew}，db:seed 旧版假记录=${broken.legacyFake}（不清理）`)
  console.log(`耗时：${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  if (!WITH_NOTIFY) {
    console.log('\n提示：直写 DB 的消息未经 im-server 广播，在线客户端请刷新页面或重启 im-server 后查看。')
  }
  console.log('验收 SQL 提示（psql/任意 PG 客户端）：')
  console.log(`  SELECT count(DISTINCT "projectId") FROM "Phase";  -- 期望 61`)
  console.log(`  SELECT count(*) FROM "Phase";                     -- 期望 ≈1220`)
  console.log(`  SELECT count(DISTINCT "userId") FROM "TodoItem";  -- 期望 ≥18`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
