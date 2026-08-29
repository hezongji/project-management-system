/**
 * 流程引擎（phase-engine）单测 —— P1-1
 *
 * 依据《开发文档-项目管理系统重构》§5/§7.4/§7.5/§9.4/§10.2，真库（pm_dev）集成测试：
 *   A. 项目编号生成（跨年重置 / 作废编号不复用 / 显式 code）
 *   B. instantiateProject 五动作（Project / Phase 岗位匹配 / FileCatalog+FileRequirement
 *      编号规则 / 会话+欢迎消息 / 阶段负责人自动入成员）
 *   C. stageOverrides 覆盖（ownerId / skip）
 *   D. 事务回滚（非法 customerId / 非法成员 userId 触发建 Project 后失败 / 非法模板 / 非法 override）
 *   E. PG NOTIFY im_events（conv:created + message:new，借 im-server/node_modules/pg 监听）
 *   F. onTaskChanged 状态联动四规则 + progress 回写 + canMarkPhaseDone
 *
 * 数据纪律：只复用真库种子账号/模板/客户；自建项目统一记录，afterAll 后进先出（LIFO）清理。
 */

import 'dotenv/config'
import { prisma } from '../prisma'
import {
  instantiateProject,
  nextProjectCode,
  onTaskChanged,
  computeProjectProgress,
  canMarkPhaseDone,
  matchOwnerForJobTitle,
  EngineError,
} from '../phase-engine'

// ───────────────────────── 真库 fixtures ─────────────────────────

async function getUserId(email: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  return u.id
}

let adminId: string
let pmWangjianId: string
let sunruoqingId: string
let machaoId: string
let zhutingId: string
let customerId: string
let tpl20Id: string
let tpl10Id: string
/** 生产主管多人场景：按 createdAt 升序的期望第一名 */
let firstProdSupervisorId: string
/** 项目经理多人场景（吴月桐/徐见山）：按 createdAt 升序的期望第一名 */
let firstProjectManagerId: string

/** 20 步模板完整实例化的共享项目 */
let mainProjectId: string
let mainProjectCode: string
/** 10 步模板 + override 的共享项目 */
let overrideProjectId: string
/** 状态联动共享项目（10 步模板） */
let linkageProjectId: string

const createdProjectIds: string[] = []

beforeAll(async () => {
  adminId = await getUserId('chenmuzhi@example.com')
  pmWangjianId = await getUserId('zhoujincheng@example.com')
  sunruoqingId = await getUserId('sunruoqing@example.com')
  machaoId = await getUserId('machengzhi@example.com')
  zhutingId = await getUserId('zhuzian@example.com')

  const customer = await prisma.externalOrg.findFirstOrThrow({
    where: { type: 'CUSTOMER' },
    select: { id: true },
  })
  customerId = customer.id

  const tpl20 = await prisma.processTemplate.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true },
  })
  tpl20Id = tpl20.id
  const tpl10 = await prisma.processTemplate.findFirstOrThrow({
    where: { name: { contains: '精简' } },
    select: { id: true },
  })
  tpl10Id = tpl10.id

  // 多人同岗位 → 期望「第一个在职的」＝createdAt 最早
  const prodSupervisors = await prisma.user.findMany({
    where: { jobTitle: '生产主管', isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  firstProdSupervisorId = prodSupervisors[0].id
  const projectManagers = await prisma.user.findMany({
    where: { jobTitle: '项目经理', isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  firstProjectManagerId = projectManagers[0].id
}, 60_000)

afterAll(async () => {
  // LIFO 清理自建项目（催办待办挂在 sourceId=条目 id，先于项目级联删除清理）
  for (const pid of createdProjectIds.reverse()) {
    const reqs = await prisma.fileRequirement.findMany({
      where: { projectId: pid },
      select: { id: true },
    })
    if (reqs.length > 0) {
      await prisma.todoItem.deleteMany({ where: { sourceId: { in: reqs.map((r) => r.id) } } })
    }
    await prisma.conversation.deleteMany({ where: { projectId: pid } })
    await prisma.project.deleteMany({ where: { id: pid } })
  }
  await prisma.$disconnect()
}, 60_000)

// ───────────────────────── A. 项目编号生成（§7.4）─────────────────────────

describe('A. 项目编号生成 nextProjectCode', () => {
  test('A1 省略 code 时按当年最大流水+1 自动生成（DEMO+年后两位+3位流水）', async () => {
    const yy = String(new Date().getFullYear()).slice(-2)
    const prefix = `DEMO${yy}`
    const existing = await prisma.project.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
    })
    let max = 0
    for (const p of existing) {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(p.code)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    const code = await nextProjectCode(prisma)
    expect(code).toMatch(new RegExp(`^${prefix}\\d{3,}$`))
    expect(parseInt(code.slice(prefix.length), 10)).toBe(max + 1)
  })

  test('A2 跨年重置：signedAt=2024 → DEMO24 段取当年最大（24032）+1 = DEMO24033', async () => {
    const code = await nextProjectCode(prisma, new Date('2024-06-01'))
    expect(code).toBe('DEMO24033') // 真库 2024 段最大编号为 DEMO24032（含作废 24024/24029）
  })

  test('A3 作废编号不复用：CANCELLED 项目计入最大流水，不覆盖不跳回', async () => {
    // 自建一条 CANCELLED 项目占据 2024 段新最大编号 DEMO24050
    const dead = await prisma.project.create({
      data: {
        code: 'DEMO24050',
        name: 'P1-1 测试-作废编号占位',
        status: 'CANCELLED',
        createdBy: adminId,
      },
    })
    createdProjectIds.push(dead.id)
    try {
      const code = await nextProjectCode(prisma, new Date('2024-12-31'))
      expect(code).toBe('DEMO24051') // 24050 虽为 CANCELLED，仍计入 → 生成 24051
    } finally {
      // 立即释放，避免影响 A2（A2 先跑）与后续断言
      const idx = createdProjectIds.indexOf(dead.id)
      if (idx >= 0) createdProjectIds.splice(idx, 1)
      await prisma.project.delete({ where: { id: dead.id } }).catch(() => {})
    }
  })

  test('A4 显式传入合法 code 被采用；重复 code 报 409', async () => {
    const result = await instantiateProject(pmWangjianId, {
      code: 'DEMO98001',
      name: 'P1-1 测试-显式编号',
      customerId,
    })
    createdProjectIds.push(result.project.id)
    expect(result.project.code).toBe('DEMO98001')

    await expect(
      instantiateProject(pmWangjianId, { code: 'DEMO98001', name: 'P1-1 测试-重复编号' }),
    ).rejects.toMatchObject({ status: 409 })
  })
})

// ───────────────────────── B. 实例化五动作（§7.4）─────────────────────────

describe('B. instantiateProject 五动作（默认 20 步模板）', () => {
  let result: Awaited<ReturnType<typeof instantiateProject>>

  beforeAll(async () => {
    result = await instantiateProject(pmWangjianId, {
      name: 'P1-1 测试-食品三期产线电气总包',
      customerId,
      contractNo: 'SHYYHT0905',
      location: '河南',
      amount: 1250000,
      signedAt: '2026-08-19',
      plannedStart: '2026-09-15',
      plannedEnd: '2026-12-31',
      members: [{ userId: sunruoqingId, role: 'MANAGER', title: '技术负责人' }],
    })
    mainProjectId = result.project.id
    mainProjectCode = result.project.code
    createdProjectIds.push(mainProjectId)
  }, 60_000)

  test('B1 动作①：Project 字段正确（编号/模板/客户/创建者/计划日期）', () => {
    expect(result.project.name).toBe('P1-1 测试-食品三期产线电气总包')
    expect(result.project.code).toMatch(/^DEMO26\d{3,}$/) // 签约 2026 → 自动编号
    expect(result.project.templateId).toBe(tpl20Id)
    expect(result.project.customerId).toBe(customerId)
    expect(result.project.contractNo).toBe('SHYYHT0905')
    expect(result.project.location).toBe('河南')
    expect(result.project.amount?.toString()).toBe('1250000')
    expect(result.project.signedAt?.toISOString().slice(0, 10)).toBe('2026-08-19')
    expect(result.project.createdBy).toBe(pmWangjianId)
  })

  test('B2 动作②：20 个 Phase，PH01..PH20 连续、NOT_STARTED、名称与模板一致', async () => {
    expect(result.phaseCount).toBe(20)
    const phases = await prisma.phase.findMany({
      where: { projectId: mainProjectId },
      orderBy: { order: 'asc' },
    })
    expect(phases).toHaveLength(20)
    expect(phases.map((p) => p.code)).toEqual(
      Array.from({ length: 20 }, (_, i) => `PH${String(i + 1).padStart(2, '0')}`),
    )
    expect(phases.every((p) => p.status === 'NOT_STARTED')).toBe(true)
    expect(phases[0].name).toBe('商务拜访')
    expect(phases[19].name).toBe('项目归档')
    expect(phases.every((p) => p.progress === 0)).toBe(true)
  })

  test('B3 动作②：岗位匹配——商务经理→朱子安、电气工程师→孙若清、项目经理→第一顺位', async () => {
    const phases = await prisma.phase.findMany({
      where: { projectId: mainProjectId },
      select: { code: true, ownerId: true },
    })
    const byCode = new Map(phases.map((p) => [p.code, p.ownerId]))
    expect(byCode.get('PH01')).toBe(zhutingId) // 商务经理
    expect(byCode.get('PH05')).toBe(sunruoqingId) // 电气工程师
    expect(byCode.get('PH09')).toBe(sunruoqingId) // 电柜制作（电气工程师）
    expect(byCode.get('PH16')).toBe(firstProjectManagerId) // 项目经理（多人取第一）
    expect(byCode.get('PH08')).toBe(firstProdSupervisorId) // 生产主管（多人取第一）
  })

  test('B4 动作②：匹配不到（物流/现场/调试/售后在册无人）→ ownerId=null 且入 pendingAssignment', () => {
    expect(result.pendingAssignment).toHaveLength(6) // 物流PH10 + 现场PH11/14/15 + 调试PH13 + 售后PH19
    const codes = result.pendingAssignment.map((p) => p.phaseCode).sort()
    expect(codes).toEqual(['PH10', 'PH11', 'PH13', 'PH14', 'PH15', 'PH19'])
    const ph10 = result.pendingAssignment.find((p) => p.phaseCode === 'PH10')!
    expect(ph10.ownerJobTitle).toBe('物流专员')
    expect(ph10.name).toBe('发货')
  })

  test('B5 动作③：FileCatalog 每阶段一目录 NN-阶段名 + phaseCode 关联', async () => {
    expect(result.catalogCount).toBe(20)
    const catalogs = await prisma.fileCatalog.findMany({
      where: { projectId: mainProjectId },
      orderBy: { order: 'asc' },
    })
    expect(catalogs).toHaveLength(20)
    expect(catalogs[0].name).toBe('01-商务拜访')
    expect(catalogs[0].phaseCode).toBe('PH01')
    expect(catalogs[4].name).toBe('05-电气设计')
    expect(catalogs[4].phaseCode).toBe('PH05')
    expect(catalogs[19].name).toBe('20-项目归档')
  })

  test('B6 动作③：FileRequirement 33 条，code 规则 PROJ-PHxx-E-00N，属性自 deliverables 映射', async () => {
    expect(result.requirementCount).toBe(33)
    const reqs = await prisma.fileRequirement.findMany({
      where: { projectId: mainProjectId, phaseCode: 'PH05' },
      orderBy: { code: 'asc' },
    })
    expect(reqs).toHaveLength(3)
    expect(reqs.map((r) => r.code)).toEqual([
      'PROJ-PH05-E-001',
      'PROJ-PH05-E-002',
      'PROJ-PH05-E-003',
    ])
    expect(reqs.map((r) => r.name)).toEqual(['电气原理图', '元件清单', 'PLC程序'])
    expect(reqs.every((r) => r.required)).toBe(true)
    expect(reqs[0].purpose).toBe('报审')
    expect(reqs[0].scope).toBe('RESTRICTED')
    expect(reqs[1].scope).toBe('PUBLIC') // 元件清单
    expect(reqs.every((r) => r.status === 'WAITING')).toBe(true)
    expect(reqs.every((r) => r.ownerId === sunruoqingId)).toBe(true) // 条目责任人=阶段负责人
  })

  test('B7 动作③：非必需交付物 required=false（PH04 PFMEA / PH19 服务记录）', async () => {
    const pfmea = await prisma.fileRequirement.findFirst({
      where: { projectId: mainProjectId, name: 'PFMEA' },
    })
    expect(pfmea?.required).toBe(false)
    const service = await prisma.fileRequirement.findFirst({
      where: { projectId: mainProjectId, name: '服务记录' },
    })
    expect(service?.required).toBe(false)
  })

  test('B8 动作④：PROJECT_GROUP 会话 + 名称 + 创建者', async () => {
    const conv = await prisma.conversation.findUniqueOrThrow({
      where: { id: result.conversationId },
      include: { members: true },
    })
    expect(conv.type).toBe('PROJECT_GROUP')
    expect(conv.name).toBe(`${mainProjectCode} P1-1 测试-食品三期产线电气总包项目群`)
    expect(conv.projectId).toBe(mainProjectId)
    expect(conv.createdBy).toBe(pmWangjianId)
    expect(conv.members.length).toBe(result.memberCount)
  })

  test('B9 动作④：会话成员 = 全部项目成员（含创建者 OWNER）', async () => {
    const convMembers = await prisma.conversationMember.findMany({
      where: { conversationId: result.conversationId },
      select: { userId: true, role: true },
    })
    const projectMembers = await prisma.projectMember.findMany({
      where: { projectId: mainProjectId },
      select: { userId: true, role: true },
    })
    expect(new Set(convMembers.map((m) => m.userId))).toEqual(
      new Set(projectMembers.map((m) => m.userId)),
    )
    expect(
      convMembers.find((m) => m.userId === pmWangjianId)?.role,
    ).toBe('OWNER') // MemberRole.OWNER
  })

  test('B10 动作④：SYSTEM 欢迎消息存在且内容含项目与模板信息', async () => {
    const msg = await prisma.message.findFirstOrThrow({
      where: { conversationId: result.conversationId, type: 'SYSTEM' },
    })
    expect(msg.senderId).toBe(pmWangjianId)
    expect(msg.content).toContain(mainProjectCode)
    expect(msg.content).toContain('20 个阶段')
  })

  test('B11 阶段负责人自动并入项目成员（孙若清 = PH05/PH09/PH12 负责人）', async () => {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: mainProjectId, userId: sunruoqingId } },
    })
    // body.members 中孙若清显式为 MANAGER —— 显式成员优先，不降级
    expect(membership?.role).toBe('MANAGER')
    expect(membership?.title).toBe('技术负责人')
  })

  test('B12 自动并入的纯阶段负责人（朱子安，未在 body.members 中）为 MEMBER', async () => {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: mainProjectId, userId: zhutingId } },
    })
    expect(membership?.role).toBe('MEMBER')
    expect(membership?.title).toBe('商务经理')
  })

  test('B13 创建者恒为 OWNER', async () => {
    const membership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: mainProjectId, userId: pmWangjianId } },
    })
    expect(membership.role).toBe('OWNER')
  })
})

// ───────────────────────── C. stageOverrides 覆盖 ─────────────────────────

describe('C. stageOverrides 覆盖（精简 10 步模板）', () => {
  let result: Awaited<ReturnType<typeof instantiateProject>>

  beforeAll(async () => {
    result = await instantiateProject(pmWangjianId, {
      name: 'P1-1 测试-override 项目',
      customerId,
      templateId: tpl10Id,
      stageOverrides: [
        { order: 4, ownerId: machaoId }, // 10步模板 order4=电气设计，覆盖为马承志
        { order: 7, skip: true }, // order7=现场调试 → 跳过
      ],
    })
    overrideProjectId = result.project.id
    createdProjectIds.push(overrideProjectId)
  }, 60_000)

  test('C1 ownerId 覆盖：PH04 负责人 = 马承志（覆盖岗位匹配的孙若清）', async () => {
    const ph04 = await prisma.phase.findUniqueOrThrow({
      where: { projectId_code: { projectId: overrideProjectId, code: 'PH04' } },
    })
    expect(ph04.ownerId).toBe(machaoId)
    // 该阶段文件条目责任人同步为覆盖后的负责人
    const reqs = await prisma.fileRequirement.findMany({
      where: { projectId: overrideProjectId, phaseCode: 'PH04' },
    })
    expect(reqs.length).toBe(3)
    expect(reqs.every((r) => r.ownerId === machaoId)).toBe(true)
  })

  test('C2 skip=true：PH07 置 SKIPPED + skippedNote，且不生成目录与文件条目', async () => {
    const ph07 = await prisma.phase.findUniqueOrThrow({
      where: { projectId_code: { projectId: overrideProjectId, code: 'PH07' } },
    })
    expect(ph07.status).toBe('SKIPPED')
    expect(ph07.skippedNote).toBeTruthy()
    const catalog = await prisma.fileCatalog.findFirst({
      where: { projectId: overrideProjectId, phaseCode: 'PH07' },
    })
    expect(catalog).toBeNull()
    const reqs = await prisma.fileRequirement.count({
      where: { projectId: overrideProjectId, phaseCode: 'PH07' },
    })
    expect(reqs).toBe(0)
    // 10 步模板 17 条 deliverable，skip 掉现场调试（1 条）→ 16 条
    expect(result.requirementCount).toBe(16)
    expect(result.catalogCount).toBe(9)
    expect(result.phaseCount).toBe(10)
  })
})

// ───────────────────────── D. 事务回滚（⑤ 全回滚）─────────────────────────

describe('D. 事务回滚：任一失败全回滚（库中无残留）', () => {
  test('D1 非法 customerId → EngineError 400，无任何写入', async () => {
    const before = await prisma.project.count()
    await expect(
      instantiateProject(pmWangjianId, {
        name: 'P1-1 测试-回滚-非法客户',
        customerId: 'nonexistent-customer-id',
      }),
    ).rejects.toMatchObject({ status: 400 })
    const after = await prisma.project.count()
    expect(after).toBe(before)
  })

  test('D2 非法成员 userId（建 Project 之后失败）→ 全回滚无残留', async () => {
    const beforeProject = await prisma.project.count()
    const beforeConv = await prisma.conversation.count()
    const beforePhase = await prisma.phase.count()
    await expect(
      instantiateProject(pmWangjianId, {
        code: 'DEMO98002',
        name: 'P1-1 测试-回滚-非法成员',
        members: [{ userId: 'nonexistent-user-id', role: 'MEMBER' }],
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await prisma.project.count()).toBe(beforeProject)
    expect(await prisma.conversation.count()).toBe(beforeConv)
    expect(await prisma.phase.count()).toBe(beforePhase)
    expect(await prisma.project.findUnique({ where: { code: 'DEMO98002' } })).toBeNull()
  })

  test('D3 非法 templateId → EngineError 400', async () => {
    await expect(
      instantiateProject(pmWangjianId, {
        name: 'P1-1 测试-回滚-非法模板',
        templateId: 'nonexistent-template-id',
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('D4 override 指定不存在/离职人员 → EngineError 400', async () => {
    await expect(
      instantiateProject(pmWangjianId, {
        name: 'P1-1 测试-回滚-非法override',
        templateId: tpl10Id,
        stageOverrides: [{ order: 1, ownerId: 'nonexistent-user-id' }],
      }),
    ).rejects.toMatchObject({ status: 400 })
  })
})

// ───────────────────────── E. PG NOTIFY im_events（§9.4）─────────────────────────

describe('E. PG NOTIFY im_events 联动', () => {
  test('E1 实例化触发 conv:created + message:new 两条 NOTIFY', async () => {
    // 主项目无 pg 依赖，借用 im-server 的 pg（仅测试环境监听用；结构化最小类型，避免依赖其 .d.ts）
    interface PgNotification { channel: string; payload?: string }
    interface PgClientLike {
      connect(): Promise<void>
      query(sql: string): Promise<unknown>
      on(event: 'notification', cb: (msg: PgNotification) => void): unknown
      end(): Promise<void>
    }
    interface PgModule {
      Client: new (opts: { connectionString?: string }) => PgClientLike
    }
    let pgMod: PgModule | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pgMod = require('../../../im-server/node_modules/pg') as PgModule
    } catch {
      console.warn('跳过 NOTIFY 监听用例：无法加载 im-server/node_modules/pg')
      return
    }
    const client: PgClientLike = new pgMod.Client({
      connectionString: process.env.DATABASE_URL,
    })
    await client.connect()
    try {
      await client.query('LISTEN im_events')
      const events: { channel: string; payload: string }[] = []
      client.on('notification', (msg) => events.push({ channel: msg.channel, payload: msg.payload || '' }))

      const result = await instantiateProject(pmWangjianId, {
        name: 'P1-1 测试-NOTIFY 项目',
        customerId,
        templateId: tpl10Id,
      })
      createdProjectIds.push(result.project.id)

      // NOTIFY 在事务提交时投递；等待事件到达（最多 8s）
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const kinds = events.map((e) => JSON.parse(e.payload).event)
        if (kinds.includes('conv:created') && kinds.includes('message:new')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const payloads = events.map((e) => JSON.parse(e.payload))
      const convCreated = payloads.find((p) => p.event === 'conv:created')
      const messageNew = payloads.find((p) => p.event === 'message:new')
      expect(convCreated).toBeTruthy()
      expect(convCreated.conversation.id).toBe(result.conversationId)
      expect(convCreated.conversation.type).toBe('PROJECT_GROUP')
      expect(Array.isArray(convCreated.conversation.members)).toBe(true)
      expect(convCreated.conversation.members.length).toBe(result.memberCount)
      expect(messageNew).toBeTruthy()
      expect(messageNew.conversationId).toBe(result.conversationId)
    } finally {
      await client.end().catch(() => {})
    }
  }, 30_000)
})

// ───────────────────────── F. onTaskChanged 状态联动（§7.5）─────────────────────────

describe('F. onTaskChanged 状态联动四规则 + progress 回写', () => {
  let ph02Id: string // 方案设计（checklist 实验组）
  let ph04Id: string // 电气设计（催办实验组）
  let ph05Id: string // 采购（CANCELLED 实验组）
  let ph01Id: string // 商务拜访（canMarkPhaseDone 实验组）
  let ph04TaskAId: string // PH04 首个任务（F1 建，F2 复用）
  let taskSeq = 0

  async function newTask(phaseId: string, status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED') {
    taskSeq++
    return prisma.task.create({
      data: {
        phaseId,
        projectId: linkageProjectId,
        title: `P1-1 联动测试任务 ${taskSeq}`,
        status,
        assigneeId: sunruoqingId,
        creatorId: pmWangjianId,
        ...(status === 'IN_PROGRESS' || status === 'DONE' ? { startedAt: new Date() } : {}),
        ...(status === 'DONE' ? { completedAt: new Date() } : {}),
      },
    })
  }

  beforeAll(async () => {
    const result = await instantiateProject(pmWangjianId, {
      name: 'P1-1 测试-状态联动项目',
      customerId,
      templateId: tpl10Id, // 10 步模板提速
    })
    linkageProjectId = result.project.id
    createdProjectIds.push(linkageProjectId)
    const getPhase = async (code: string) =>
      (
        await prisma.phase.findUniqueOrThrow({
          where: { projectId_code: { projectId: linkageProjectId, code } },
        })
      ).id
    ph01Id = await getPhase('PH01')
    ph02Id = await getPhase('PH02')
    ph04Id = await getPhase('PH04')
    ph05Id = await getPhase('PH05')
  }, 60_000)

  test('F1 规则1：任一子任务开始 → Phase IN_PROGRESS + actualStart', async () => {
    const t = await newTask(ph04Id, 'IN_PROGRESS')
    ph04TaskAId = t.id
    const r = await onTaskChanged(t.id)
    expect(r.affected).toBe(true)
    expect(r.phase.code).toBe('PH04')
    expect(r.phase.status).toBe('IN_PROGRESS')
    expect(r.phase.actualStart).not.toBeNull()
    expect(r.phaseStatusChanged).toBe(true)
  })

  test('F2 规则4：progress 回写 —— 1/2 任务 DONE → Phase.progress=50', async () => {
    await newTask(ph04Id, 'TODO') // 第二个任务保持 TODO
    await prisma.task.update({ where: { id: ph04TaskAId }, data: { status: 'DONE', completedAt: new Date() } })
    const r = await onTaskChanged(ph04TaskAId)
    expect(r.phase.progress).toBe(50)
    expect(r.phase.status).toBe('IN_PROGRESS')
  })

  test('F3 规则2：全部 DONE 但 checklist 未全勾 → 不置 DONE', async () => {
    await prisma.phase.update({
      where: { id: ph02Id },
      data: {
        checklist: [{ text: '方案评审通过', checked: false, checkedBy: null, checkedAt: null }],
        status: 'IN_PROGRESS',
        actualStart: new Date(),
      },
    })
    const t1 = await newTask(ph02Id, 'DONE')
    const t2 = await newTask(ph02Id, 'DONE')
    await onTaskChanged(t1.id)
    const r = await onTaskChanged(t2.id)
    expect(r.phase.status).toBe('IN_PROGRESS') // 被 checklist 卡住
    expect(r.phase.progress).toBe(100)
    const check = await canMarkPhaseDone(ph02Id)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('检查项')
  })

  test('F4 规则2：checklist 全勾后 → 置 DONE + actualEnd', async () => {
    await prisma.phase.update({
      where: { id: ph02Id },
      data: {
        checklist: [{ text: '方案评审通过', checked: true, checkedBy: pmWangjianId, checkedAt: new Date() }],
      },
    })
    const t = await prisma.task.findFirstOrThrow({ where: { phaseId: ph02Id } })
    const r = await onTaskChanged(t.id)
    expect(r.phase.status).toBe('DONE')
    expect(r.phase.actualEnd).not.toBeNull()
    expect(canMarkPhaseDone(ph02Id)).resolves.toMatchObject({ ok: true })
  })

  test('F5 checklist 为 null 视为全勾：全部 DONE → 直接 DONE', async () => {
    // 把 PH04 剩余 TODO 任务置 DONE → 全部任务 DONE
    const pending = await prisma.task.findFirstOrThrow({ where: { phaseId: ph04Id, status: 'TODO' } })
    await prisma.task.update({ where: { id: pending.id }, data: { status: 'DONE', completedAt: new Date() } })
    const r = await onTaskChanged(pending.id)
    expect(r.phase.status).toBe('DONE') // PH04 checklist=null
    expect(r.phase.actualEnd).not.toBeNull()
    expect(r.todosCreated).toBe(3) // 规则3同步触发（3 条 WAITING 交付物）
  })

  test('F6 规则3：Phase DONE → WAITING 条目生成催办待办（PH04 有 3 条交付物）', async () => {
    const reqs = await prisma.fileRequirement.findMany({
      where: { projectId: linkageProjectId, phaseCode: 'PH04' },
    })
    expect(reqs).toHaveLength(3)
    const todos = await prisma.todoItem.findMany({
      where: { sourceType: 'FILE_REQ', sourceId: { in: reqs.map((r) => r.id) } },
    })
    expect(todos).toHaveLength(3)
    expect(todos.every((t) => t.userId === sunruoqingId)).toBe(true) // 条目责任人=阶段负责人
    expect(todos.every((t) => t.priority === 'HIGH')).toBe(true)
    expect(todos[0].title).toContain('催办')
    expect(todos[0].link).toContain(`/files?projectId=${linkageProjectId}`)
  })

  test('F7 幂等：Phase 已 DONE 再联动 → 不重复催办', async () => {
    const t = await prisma.task.findFirstOrThrow({ where: { phaseId: ph04Id } })
    const r = await onTaskChanged(t.id)
    expect(r.phase.status).toBe('DONE')
    expect(r.todosCreated).toBe(0)
    expect(r.phaseStatusChanged).toBe(false)
    const reqs = await prisma.fileRequirement.findMany({
      where: { projectId: linkageProjectId, phaseCode: 'PH04' },
      select: { id: true },
    })
    const todos = await prisma.todoItem.count({
      where: { sourceType: 'FILE_REQ', sourceId: { in: reqs.map((r) => r.id) } },
    })
    expect(todos).toBe(3)
  })

  test('F8 CANCELLED 任务剔除分母：1 DONE + 1 CANCELLED → progress=100 → DONE', async () => {
    const t1 = await newTask(ph05Id, 'DONE')
    const t2 = await newTask(ph05Id, 'TODO')
    await prisma.task.update({ where: { id: t2.id }, data: { status: 'CANCELLED' } })
    const r = await onTaskChanged(t1.id)
    expect(r.phase.code).toBe('PH05')
    expect(r.phase.progress).toBe(100)
    expect(r.phase.status).toBe('DONE')
  })

  test('F9 未挂阶段的历史任务 → affected=false，仅回写项目进度', async () => {
    const t = await prisma.task.create({
      data: {
        phaseId: null,
        projectId: linkageProjectId,
        title: 'P1-1 历史任务（无阶段）',
        creatorId: pmWangjianId,
      },
    })
    const r = await onTaskChanged(t.id)
    expect(r.affected).toBe(false)
    expect(r.projectProgress).toBeGreaterThanOrEqual(0)
  })

  test('F10 progress 回写 Project：Phase 均值（PH02/PH04/PH05 均 100，其余 0 → 30）', async () => {
    // 10 步模板 10 个阶段：3 个 100 分 → 均值 30
    const progress = await computeProjectProgress(linkageProjectId)
    expect(progress).toBe(30)
  })

  test('F11 SKIPPED 阶段不计入项目均值分母', async () => {
    await prisma.phase.update({
      where: { id: ph01Id },
      data: { status: 'SKIPPED', skippedNote: '测试跳过' },
    })
    const progress = await computeProjectProgress(linkageProjectId)
    expect(progress).toBe(Math.round(300 / 9)) // 9 个有效阶段
  })

  test('F12 canMarkPhaseDone：有未完成任务 → false（含未完成计数）', async () => {
    const ph03 = await prisma.phase.findUniqueOrThrow({
      where: { projectId_code: { projectId: linkageProjectId, code: 'PH03' } },
    })
    const t = await newTask(ph03.id, 'TODO')
    const check = await canMarkPhaseDone(t.phaseId!)
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/1 个任务未完成/)
  })

  test('F13 任务不存在 → EngineError 404', async () => {
    await expect(onTaskChanged('nonexistent-task-id')).rejects.toMatchObject({ status: 404 })
  })
})

// ───────────────────────── 附：matchOwnerForJobTitle 单测 ─────────────────────────

describe('附. 岗位匹配 matchOwnerForJobTitle', () => {
  test('匹配到在职人员（商务经理→朱子安）', async () => {
    const m = await matchOwnerForJobTitle(prisma, '商务经理')
    expect(m?.id).toBe(zhutingId)
  })

  test('在册无人的岗位（物流专员）→ null', async () => {
    const m = await matchOwnerForJobTitle(prisma, '物流专员')
    expect(m).toBeNull()
  })
})
