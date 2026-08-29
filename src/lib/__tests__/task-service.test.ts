/**
 * 任务修订引擎（task-service）单测 —— P1-5
 *
 * 依据《开发文档-项目管理系统重构》§5 TaskRevision / §7.6，两部分：
 *   A. 纯函数：changeSummary 校验 / 快照提取 / 差异检测 / 字段 diff / 白名单过滤
 *   B. 真库（pm_dev）集成：applyRevision（快照→TaskRevision→patch→revision+1、
 *      空修订拒绝、非法 assignee 拒绝）+ rollbackRevision（回滚=生成新修订快照当前值、
 *      目标版本不存在拒绝、内容一致拒绝）+ 版本序列连续性
 *
 * 数据纪律：复用真库种子项目 DEMO25021；自建任务记录在案，afterAll 统一清理
 * （Task 级联删除 TaskRevision/Annotation/Comment，手动清 Notification/TodoItem）。
 */

import 'dotenv/config'
import { prisma } from '../prisma'
import {
  validateChangeSummary,
  snapshotOf,
  snapshotDiffers,
  diffSnapshots,
  pickPatchFields,
  applyRevision,
  rollbackRevision,
  REVISABLE_FIELDS,
} from '../task-service'
import { EngineError } from '../phase-engine'

const baseTask = {
  title: '绘制电气原理图',
  description: '含主回路与控制回路',
  status: 'TODO' as const,
  priority: 'MEDIUM' as const,
  assigneeId: 'u1',
  dueDate: new Date('2026-09-30T00:00:00Z'),
}

// ───────────────────────── A. 纯函数 ─────────────────────────

describe('A1. validateChangeSummary（§7.6 >10 字）', () => {
  it('拒绝短说明（≤10 字，10 字边界也拒绝）', () => {
    expect(() => validateChangeSummary('改了个标题')).toThrow(EngineError)
    expect(() => validateChangeSummary('刚好十个字呢1234')).toThrow(EngineError) // 10 字边界：拒绝
    expect(() => validateChangeSummary('刚好十个字呢12345')).not.toThrow() // 11 字：通过
  })
  it('trim 后计数；非字符串拒绝', () => {
    expect(() => validateChangeSummary('   足够长的修订说明文字！  ')).not.toThrow()
    expect(() => validateChangeSummary(123)).toThrow(EngineError)
    expect(() => validateChangeSummary(null)).toThrow(EngineError)
  })
})

describe('A2. snapshotOf / snapshotDiffers / diffSnapshots', () => {
  it('快照六字段，dueDate 转 ISO 串', () => {
    const snap = snapshotOf(baseTask)
    expect(snap).toEqual({
      title: '绘制电气原理图',
      description: '含主回路与控制回路',
      status: 'TODO',
      priority: 'MEDIUM',
      assigneeId: 'u1',
      dueDate: '2026-09-30T00:00:00.000Z',
    })
    expect(snapshotOf({ ...baseTask, dueDate: null }).dueDate).toBeNull()
  })
  it('差异检测覆盖六字段', () => {
    const a = snapshotOf(baseTask)
    expect(snapshotDiffers(a, { ...a, title: 'x' })).toBe(true)
    expect(snapshotDiffers(a, { ...a, priority: 'HIGH' as never })).toBe(true)
    expect(snapshotDiffers(a, { ...a })).toBe(false)
  })
  it('diffSnapshots 只含有差异字段', () => {
    const a = snapshotOf(baseTask)
    const b = { ...a, title: '新标题', assigneeId: null }
    const diff = diffSnapshots(a, b)
    expect(Object.keys(diff).sort()).toEqual(['assigneeId', 'title'])
    expect(diff.title).toEqual({ old: '绘制电气原理图', new: '新标题' })
    expect(diff.assigneeId).toEqual({ old: 'u1', new: null })
  })
})

describe('A3. pickPatchFields（白名单）', () => {
  it('过滤非白名单字段', () => {
    const fields = pickPatchFields({
      title: 'a', id: 'hack', projectId: 'hack', revision: 99, status: 'DONE', __proto: 1 as never,
    })
    expect(fields.sort()).toEqual(['status', 'title'])
    expect(REVISABLE_FIELDS).not.toContain('projectId')
  })
})

// ───────────────────────── B. 真库集成 ─────────────────────────

describe('B. applyRevision / rollbackRevision（真库事务）', () => {
  const createdTaskIds: string[] = []
  const SEED_PROJECT_CODE = 'DEMO25021'

  afterAll(async () => {
    for (const id of createdTaskIds) {
      await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {})
      await prisma.todoItem.deleteMany({ where: { sourceId: id } }).catch(() => {})
      await prisma.task.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  async function seedTask() {
    const project = await prisma.project.findUniqueOrThrow({
      where: { code: SEED_PROJECT_CODE },
      select: { id: true },
    })
    const phase = await prisma.phase.findFirstOrThrow({
      where: { projectId: project.id, code: 'PH06' },
      select: { id: true },
    })
    const task = await prisma.task.create({
      data: {
        title: 'P1-5 单测种子任务',
        projectId: project.id,
        phaseId: phase.id,
        creatorId: (
          await prisma.user.findUniqueOrThrow({
            where: { email: 'chenmuzhi@example.com' },
            select: { id: true },
          })
        ).id,
      },
    })
    createdTaskIds.push(task.id)
    return task
  }

  it('修订：快照旧值→TaskRevision(version=1)→应用 patch→revision=2', async () => {
    const task = await seedTask()
    const r = await prisma.$transaction((tx) =>
      applyRevision(tx, task.id, task.creatorId, '第一次修订：调整负责人与优先级以匹配现场进度', {
        priority: 'HIGH',
        title: 'P1-5 单测种子任务（修订后）',
      }),
    )
    expect(r.task.revision).toBe(2)
    expect(r.task.priority).toBe('HIGH')
    expect(r.revision.version).toBe(1)
    expect(r.before.title).toBe('P1-5 单测种子任务')
    expect(r.before.priority).toBe('MEDIUM')

    const record = await prisma.taskRevision.findUniqueOrThrow({
      where: { taskId_version: { taskId: task.id, version: 1 } },
    })
    expect(record.changeSummary).toContain('第一次修订')
    expect((record.snapshot as never as Record<string, unknown>).title).toBe('P1-5 单测种子任务')
  })

  it('短 changeSummary → 拒绝且不落任何记录', async () => {
    const task = await seedTask()
    await expect(
      prisma.$transaction((tx) => applyRevision(tx, task.id, task.creatorId, '太短', { title: 'x' })),
    ).rejects.toThrow(EngineError)
    const count = await prisma.taskRevision.count({ where: { taskId: task.id } })
    expect(count).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).revision).toBe(1)
  })

  it('空 patch / 新旧值相同 → 拒绝空修订', async () => {
    const task = await seedTask()
    await expect(
      prisma.$transaction((tx) =>
        applyRevision(tx, task.id, task.creatorId, '这是一个足够长的修订说明文字', {}),
      ),
    ).rejects.toThrow(EngineError)
    await expect(
      prisma.$transaction((tx) =>
        applyRevision(tx, task.id, task.creatorId, '这是一个足够长的修订说明文字', {
          title: 'P1-5 单测种子任务', // 与当前值相同
        }),
      ),
    ).rejects.toThrow(/未产生任何字段变更/)
  })

  it('非法 assigneeId → 400', async () => {
    const task = await seedTask()
    await expect(
      prisma.$transaction((tx) =>
        applyRevision(tx, task.id, task.creatorId, '这是一个足够长的修订说明文字', {
          assigneeId: 'nonexistent-user',
        }),
      ),
    ).rejects.toThrow(/assigneeId 不存在/)
  })

  it('回滚：生成新修订（快照当前值）→ 恢复目标字段 → revision 递增，版本序列连续', async () => {
    const task = await seedTask()
    // 修订①：改 priority
    await prisma.$transaction((tx) =>
      applyRevision(tx, task.id, task.creatorId, '第一次修订：优先级升级为高优先级处理', {
        priority: 'HIGH',
      }),
    )
    // 修订②：改 title + priority
    await prisma.$transaction((tx) =>
      applyRevision(tx, task.id, task.creatorId, '第二次修订：标题重命名并降回中等优先级', {
        title: '第二次修订后的标题',
        priority: 'MEDIUM',
      }),
    )
    const before3 = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(before3.revision).toBe(3)

    // 回滚到 v1（初始状态：原标题 / MEDIUM）
    const rb = await prisma.$transaction((tx) =>
      rollbackRevision(tx, task.id, task.creatorId, 1),
    )
    // 「回滚=生成新修订」：revision 3→4，新记录 version=3、快照=回滚前状态
    expect(rb.task.revision).toBe(4)
    expect(rb.task.title).toBe('P1-5 单测种子任务') // 字段恢复
    expect(rb.task.priority).toBe('MEDIUM')
    expect(rb.revision.version).toBe(3)
    expect(rb.revision.snapshot.title).toBe('第二次修订后的标题') // 快照的是回滚前值

    const versions = (
      await prisma.taskRevision.findMany({
        where: { taskId: task.id },
        orderBy: { version: 'asc' },
        select: { version: true },
      })
    ).map((v) => v.version)
    expect(versions).toEqual([1, 2, 3]) // 版本序列连续不重
  })

  it('回滚目标版本不存在 / 内容已一致 → 拒绝', async () => {
    const task = await seedTask() // 无任何修订记录
    await expect(
      prisma.$transaction((tx) => rollbackRevision(tx, task.id, task.creatorId, 1)),
    ).rejects.toThrow(/不存在/)

    await prisma.$transaction((tx) =>
      applyRevision(tx, task.id, task.creatorId, '第一次修订：优先级升级为高优先级处理', {
        priority: 'HIGH',
      }),
    )
    // 当前状态与 v1 快照……v1 快照=修订前=MEDIUM，当前 HIGH，有差异可回滚；回滚后内容与 v1 相同：
    await prisma.$transaction((tx) => rollbackRevision(tx, task.id, task.creatorId, 1))
    // 再回滚 v1：当前内容已与 v1 快照一致（回滚已恢复），但 v1/v2 快照是 MEDIUM，
    // 而当前=MEDIUM → 与目标 v1 一致 → 拒绝
    await expect(
      prisma.$transaction((tx) => rollbackRevision(tx, task.id, task.creatorId, 1)),
    ).rejects.toThrow(/一致/)
  })
})
