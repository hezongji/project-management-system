/**
 * 文件条目审核流 + 到期催办（file-review）单测 —— P2-3
 *
 * 依据《开发文档-项目管理系统重构》§5/§6.1/§7.7/§7.9，真库（pm_dev）集成测试：
 *   A. approve：SUBMITTED/REVIEWING → APPROVED；写 FileAccessLog(APPROVE)；
 *      通知责任人（Notification FILE_APPROVED）；记 ActivityLog file.approve
 *   B. reject：→ REJECTED；FileAccessLog(REJECT)；通知责任人（FILE_PENDING_REVIEW）
 *   C. na：→ NA + remark 备注 + ActivityLog file.na（无 FileAccessLog）
 *   D. obsolete：→ OBSOLETED + remark + FileAccessLog(OBSOLETE)（若有文件）
 *   E. 状态机守卫：WAITING / 终态（APPROVED）不可审核 → FileReviewError(409)
 *   F. remindDueRequirements：3 天内（含超期）生成待办 + FILE_DUE_SOON 通知 + 幂等去重
 *
 * 数据纪律：自建测试条目统一加「P2-3测试」前缀，记录 id，afterAll 逆序清理
 * （FileAccessLog → File → TodoItem → Notification → ActivityLog → FileRequirement）。
 */

import 'dotenv/config'
import { prisma } from '../prisma'
import {
  approveRequirement,
  rejectRequirement,
  markRequirementNA,
  obsoleteRequirement,
  remindDueRequirements,
  FileReviewError,
} from '../file-review'

// ───────────────────────── 真库 fixtures ─────────────────────────

let projectId: string
let catalogId: string
let adminId: string // chenmuzhi（ADMIN，项目 OWNER，兜底责任人）
let ownerId: string // sunruoqing（MEMBER，PH05 阶段负责人，测试条目责任人）

const createdReqIds: string[] = []
const createdFileIds: string[] = []
let seq = 0

async function getUserId(email: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  return u.id
}

/** 建测试条目（默认 WAITING，owner=sunruoqing，phase=PH05，非必需） */
async function createRequirement(overrides: {
  status?: 'WAITING' | 'SUBMITTED' | 'REVIEWING' | 'APPROVED' | 'REJECTED'
  ownerId?: string | null
  dueDate?: Date | null
  name?: string
} = {}) {
  const req = await prisma.fileRequirement.create({
    data: {
      projectId,
      catalogId,
      phaseCode: 'PH05',
      name: overrides.name ?? `P2-3测试-${++seq}-${overrides.status ?? 'WAITING'}`,
      code: null,
      required: false,
      ownerId: overrides.ownerId === undefined ? ownerId : overrides.ownerId,
      status: overrides.status ?? 'WAITING',
      dueDate: overrides.dueDate === undefined ? null : overrides.dueDate,
    },
  })
  createdReqIds.push(req.id)
  return req
}

/** 为测试条目挂一个文件（approve/reject/obsolete 的 FileAccessLog 载体） */
async function createFile(requirementId: string) {
  const f = await prisma.file.create({
    data: {
      requirementId,
      projectId,
      name: 'test-v1.pdf',
      originalName: 'test.pdf',
      storagePath: `/tmp/p2-3-test/${requirementId}.pdf`,
      size: 1,
      mimeType: 'application/pdf',
      uploadedById: adminId,
    },
  })
  createdFileIds.push(f.id)
  return f
}

beforeAll(async () => {
  adminId = await getUserId('chenmuzhi@example.com')
  ownerId = await getUserId('sunruoqing@example.com')

  const project = await prisma.project.findFirstOrThrow({
    where: { code: 'DEMO25021' },
    select: { id: true },
  })
  projectId = project.id

  const catalog = await prisma.fileCatalog.findFirstOrThrow({
    where: { projectId },
    select: { id: true },
  })
  catalogId = catalog.id
})

afterAll(async () => {
  // 逆序清理（外键依赖顺序）
  await prisma.fileAccessLog.deleteMany({ where: { fileId: { in: createdFileIds } } })
  await prisma.file.deleteMany({ where: { id: { in: createdFileIds } } })
  await prisma.todoItem.deleteMany({
    where: { sourceType: 'FILE_REQ', sourceId: { in: createdReqIds } },
  })
  for (const id of createdReqIds) {
    await prisma.notification.deleteMany({ where: { link: { contains: id } } })
  }
  for (const id of createdReqIds) {
    await prisma.activityLog.deleteMany({
      where: {
        action: { in: ['file.approve', 'file.reject', 'file.na', 'file.obsolete'] },
        detail: { path: ['requirementId'], equals: id },
      },
    })
  }
  await prisma.fileRequirement.deleteMany({ where: { id: { in: createdReqIds } } })
})

// ───────────────────────── A. approve ─────────────────────────

describe('A. approveRequirement', () => {
  it('SUBMITTED → APPROVED：写 FileAccessLog(APPROVE) + 通知责任人 + ActivityLog', async () => {
    const req = await createRequirement({ status: 'SUBMITTED', name: 'P2-3测试-审核通过' })
    const file = await createFile(req.id)

    const result = await approveRequirement(adminId, req.id, '内容齐全，通过')

    expect(result.status).toBe('APPROVED')
    expect(result.logCreated).toBe(true)
    expect(result.accessLogAction).toBe('APPROVE')
    expect(result.notifiedUserIds).toContain(ownerId)

    const row = await prisma.fileRequirement.findUniqueOrThrow({ where: { id: req.id } })
    expect(row.status).toBe('APPROVED')

    const log = await prisma.fileAccessLog.findFirst({
      where: { fileId: file.id, userId: adminId, action: 'APPROVE' },
    })
    expect(log).not.toBeNull()

    const notif = await prisma.notification.findFirst({
      where: { userId: ownerId, type: 'FILE_APPROVED', link: { contains: req.id } },
    })
    expect(notif).not.toBeNull()

    const act = await prisma.activityLog.findFirst({
      where: { action: 'file.approve', detail: { path: ['requirementId'], equals: req.id } },
    })
    expect(act).not.toBeNull()
  })

  it('REVIEWING 亦可审核通过', async () => {
    const req = await createRequirement({ status: 'REVIEWING', name: 'P2-3测试-审核中通过' })
    await createFile(req.id)
    const result = await approveRequirement(adminId, req.id, '')
    expect(result.status).toBe('APPROVED')
    expect(result.logCreated).toBe(true)
  })
})

// ───────────────────────── B. reject ─────────────────────────

describe('B. rejectRequirement', () => {
  it('SUBMITTED → REJECTED：写 FileAccessLog(REJECT) + 通知责任人', async () => {
    const req = await createRequirement({ status: 'SUBMITTED', name: 'P2-3测试-驳回' })
    const file = await createFile(req.id)

    const result = await rejectRequirement(adminId, req.id, '缺少签字页')

    expect(result.status).toBe('REJECTED')
    expect(result.accessLogAction).toBe('REJECT')
    expect(result.notifiedUserIds).toContain(ownerId)

    const row = await prisma.fileRequirement.findUniqueOrThrow({ where: { id: req.id } })
    expect(row.status).toBe('REJECTED')

    const log = await prisma.fileAccessLog.findFirst({
      where: { fileId: file.id, userId: adminId, action: 'REJECT' },
    })
    expect(log).not.toBeNull()

    const notif = await prisma.notification.findFirst({
      where: { userId: ownerId, type: 'FILE_PENDING_REVIEW', link: { contains: req.id } },
    })
    expect(notif).not.toBeNull()
  })
})

// ───────────────────────── C. na ─────────────────────────

describe('C. markRequirementNA', () => {
  it('WAITING → NA：落 remark 备注 + ActivityLog，无 FileAccessLog', async () => {
    const req = await createRequirement({ status: 'WAITING', name: 'P2-3测试-不适用' })

    const result = await markRequirementNA(adminId, req.id, '本项目无此交付物')

    expect(result.status).toBe('NA')
    expect(result.accessLogAction).toBeNull()

    const row = await prisma.fileRequirement.findUniqueOrThrow({ where: { id: req.id } })
    expect(row.status).toBe('NA')
    expect(row.remark).toBe('本项目无此交付物')

    const act = await prisma.activityLog.findFirst({
      where: { action: 'file.na', detail: { path: ['requirementId'], equals: req.id } },
    })
    expect(act).not.toBeNull()
  })
})

// ───────────────────────── D. obsolete ─────────────────────────

describe('D. obsoleteRequirement', () => {
  it('WAITING → OBSOLETED：落 remark + FileAccessLog(OBSOLETE)（若有文件）', async () => {
    const req = await createRequirement({ status: 'WAITING', name: 'P2-3测试-作废' })
    const file = await createFile(req.id)

    const result = await obsoleteRequirement(adminId, req.id, '需求变更，不再需要')

    expect(result.status).toBe('OBSOLETED')
    expect(result.accessLogAction).toBe('OBSOLETE')
    expect(result.logCreated).toBe(true)

    const row = await prisma.fileRequirement.findUniqueOrThrow({ where: { id: req.id } })
    expect(row.status).toBe('OBSOLETED')
    expect(row.remark).toBe('需求变更，不再需要')

    const log = await prisma.fileAccessLog.findFirst({
      where: { fileId: file.id, userId: adminId, action: 'OBSOLETE' },
    })
    expect(log).not.toBeNull()
  })
})

// ───────────────────────── E. 状态机守卫 ─────────────────────────

describe('E. 状态机守卫', () => {
  it('WAITING 不可审核（409）', async () => {
    const req = await createRequirement({ status: 'WAITING', name: 'P2-3测试-守卫-WAITING' })
    await expect(approveRequirement(adminId, req.id, '')).rejects.toThrow(FileReviewError)
    await expect(approveRequirement(adminId, req.id, '')).rejects.toMatchObject({ status: 409 })
  })

  it('终态 APPROVED 不可重复审核（409）', async () => {
    const req = await createRequirement({ status: 'APPROVED', name: 'P2-3测试-守卫-APPROVED' })
    await expect(rejectRequirement(adminId, req.id, '')).rejects.toMatchObject({ status: 409 })
  })

  it('不存在的条目 → 404', async () => {
    await expect(approveRequirement(adminId, 'nonexistent-id', '')).rejects.toMatchObject({
      status: 404,
    })
  })
})

// ───────────────────────── F. remindDueRequirements ─────────────────────────

describe('F. remindDueRequirements（到期催办）', () => {
  const now = new Date()

  it('3 天内（含超期）生成待办 + FILE_DUE_SOON 通知；超期 HIGH / 临近 MEDIUM', async () => {
    const soon = await createRequirement({
      status: 'WAITING',
      dueDate: new Date(now.getTime() + 2 * 24 * 3600 * 1000),
      name: 'P2-3测试-催办-临近',
    })
    const overdue = await createRequirement({
      status: 'SUBMITTED',
      dueDate: new Date(now.getTime() - 24 * 3600 * 1000),
      name: 'P2-3测试-催办-超期',
    })
    // 超出 3 天：不应命中
    const far = await createRequirement({
      status: 'WAITING',
      dueDate: new Date(now.getTime() + 10 * 24 * 3600 * 1000),
      name: 'P2-3测试-催办-远期',
    })
    // APPROVED：不在催办范围（状态过滤）
    const approved = await createRequirement({
      status: 'APPROVED',
      dueDate: new Date(now.getTime() + 1 * 24 * 3600 * 1000),
      name: 'P2-3测试-催办-已通过',
    })

    const result = await remindDueRequirements({ now })

    // 断言下限（避免并发 worker 造的数据干扰全局计数），但精准校验本用例条目
    expect(result.scanned).toBeGreaterThanOrEqual(2)
    expect(result.created).toBeGreaterThanOrEqual(2)
    expect(result.notifiedUserIds).toContain(ownerId)

    const soonTodo = await prisma.todoItem.findFirst({
      where: { sourceType: 'FILE_REQ', sourceId: soon.id },
    })
    expect(soonTodo).not.toBeNull()
    expect(soonTodo!.priority).toBe('MEDIUM')
    expect(soonTodo!.dueAt?.getTime()).toBe(soon.dueDate!.getTime())

    const overdueTodo = await prisma.todoItem.findFirst({
      where: { sourceType: 'FILE_REQ', sourceId: overdue.id },
    })
    expect(overdueTodo).not.toBeNull()
    expect(overdueTodo!.priority).toBe('HIGH')

    const notif = await prisma.notification.findFirst({
      where: { userId: ownerId, type: 'FILE_DUE_SOON', link: { contains: overdue.id } },
    })
    expect(notif).not.toBeNull()

    // 过滤正确性：远期 / 已通过不生成待办
    const farTodo = await prisma.todoItem.findFirst({
      where: { sourceType: 'FILE_REQ', sourceId: far.id },
    })
    expect(farTodo).toBeNull()
    const approvedTodo = await prisma.todoItem.findFirst({
      where: { sourceType: 'FILE_REQ', sourceId: approved.id },
    })
    expect(approvedTodo).toBeNull()
  })

  it('幂等：再次运行不重复生成待办（created=0，本用例条目全部跳过）', async () => {
    const result = await remindDueRequirements({ now })
    expect(result.created).toBe(0)
    expect(result.skipped).toBeGreaterThanOrEqual(2)
  })
})
