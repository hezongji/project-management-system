/**
 * 流程引擎（phase-engine）—— 依据《开发文档-项目管理系统重构》§5 / §7.4 / §7.5 / §9.4 / §10.2
 *
 * 全系统心脏，P1 其余任务的地基。职责：
 *   1. instantiateProject(userId, body)：创建项目事务五动作
 *      ① 建 Project（编号 DEMO+签约年后两位+3位流水，按年从 001 起，作废编号不复用）
 *      ② 按 TemplateStage 批量生成 Phase（ownerJobTitle→JobTitle 匹配组织内在职人员
 *         自动填 ownerId，多人取第一个在职的；匹配不到→null 并记入 pendingAssignment；
 *         stageOverrides[{order,ownerId,skip}] 可覆盖）
 *      ③ 按 stages.deliverables 预生成 FileCatalog（每阶段目录 NN-阶段名）
 *         + FileRequirement 条目（code 规则 PROJ-PHxx-E-00N，E 段与 §7.7/§10.5 样例一致）
 *      ④ 建 PROJECT_GROUP 会话 + 拉全部成员 + 系统欢迎消息 + PG NOTIFY im_events
 *         （conv:created + message:new；NOTIFY 在事务提交时才投递，回滚不发出）
 *      ⑤ 全程 prisma.$transaction，任一失败全回滚
 *   2. onTaskChanged(taskId)：状态联动四规则（§7.5）
 *      - 任一子任务开始 → Phase IN_PROGRESS + actualStart
 *      - 全部任务 DONE + checklist 全勾 → 允许（自动）置 DONE（记 actualEnd）
 *      - Phase DONE → 对该阶段 WAITING 文件条目生成催办待办 + IM notify:push
 *      - progress 回写：task 完成率 → Phase.progress；Phase 均值 → Project
 *        （Project 无 progress 字段（§5 schema），由 computeProjectProgress 动态计算，
 *         SKIPPED 阶段不计入均值分母——否则可跳过阶段的项目永远到不了 100%）
 *
 * 工程决策（文档未明示处，均已在 P1-1 报告中列明，可追溯）：
 *   - 「第一个在职的」按 User.createdAt 升序取（入职先后，稳定可复现）
 *   - stageOverrides.skip=true → Phase 置 SKIPPED（skippedNote 记录），该阶段不生成
 *     文件目录与条目（跳过的阶段不应再有交付要求）
 *   - 匹配到/覆盖指定的阶段负责人自动并入 ProjectMember（role=MEMBER，title=岗位名）
 *     —— §6.1 中非成员对 PROJECT 资源无 view，阶段负责人必须可见项目才能履职；
 *     §10.5 示例项目亦将全部阶段负责人纳入成员表，此处与其保持一致
 *   - FileRequirement.reviewerId 实例化时不落死值（null），按 §7.7「审核人（默认阶段
 *     负责人）」运行时动态解析，避免阶段负责人变更后的数据不同步
 *   - 催办待办 ownerId 为 null 的条目 → 挂到项目负责人（ProjectMember OWNER）
 *   - 会话名 `${code} ${name}项目群`（§10.5 样例「DEMO25021 河南三期项目群」结构）
 *   - 「全部任务 DONE」中 CANCELLED 任务剔除出分母；无任务的阶段不自动 DONE
 *   - checklist 为 null / [] 视为「无检查项」即满足全勾条件
 *   - 创建者恒为 OWNER；body.members 中出现创建者时忽略其角色设置
 *   - PG NOTIFY 在事务内发出：提交时投递、回滚不投递，天然满足原子性
 */

import { prisma } from './prisma'
import { Prisma } from '@prisma/client'
import type { Phase, Project } from '@prisma/client'

// ───────────────────────────── 引擎错误 ─────────────────────────────

/**
 * 流程引擎业务错误：路由层捕获后转换为 api-helpers 的 ApiError（含 status）。
 * （不直接复用 api-helpers.ApiError，保持本模块零 next/server 依赖，可独立单测。）
 */
export class EngineError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'BAD_REQUEST') {
    super(message)
    this.name = 'EngineError'
    this.status = status
    this.code = code
  }
}

// ───────────────────────────── 类型 ─────────────────────────────

/** §7.4 POST /projects 请求体 */
export interface StageOverride {
  order: number
  ownerId?: string | null
  skip?: boolean
}

export interface MemberInput {
  userId: string
  role?: 'OWNER' | 'MANAGER' | 'MEMBER' | 'VIEWER'
  title?: string | null
  /** 个人交付物（2026-08-21）：该成员需提交的工作文件清单 */
  deliverables?: string[]
}

export interface CreateProjectInput {
  code?: string
  name: string
  description?: string
  contractNo?: string | null
  location?: string | null
  amount?: number | string | null
  customerId?: string | null
  signedAt?: string | null
  plannedStart?: string | null
  plannedEnd?: string | null
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  templateId?: string
  stageOverrides?: StageOverride[]
  members?: MemberInput[]
}

/** 模板阶段 deliverables JSON 条目（§10.2：{name, required, purpose, scope}） */
interface DeliverableDef {
  name: string
  required?: boolean
  purpose?: string
  scope?: 'PUBLIC' | 'RESTRICTED' | 'PRIVATE'
}

/** 实例化结果 */
export interface InstantiateResult {
  project: Project
  phaseCount: number
  catalogCount: number
  requirementCount: number
  conversationId: string
  memberCount: number
  /** 岗位匹配不到负责人（且未被 override 指定）的阶段清单，供前端提示待分配 */
  pendingAssignment: {
    order: number
    phaseCode: string
    name: string
    ownerJobTitle: string
  }[]
}

/** onTaskChanged 联动结果 */
export interface TaskLinkageResult {
  affected: boolean
  phase: {
    id: string
    code: string
    status: Phase['status']
    progress: number
    actualStart: Date | null
    actualEnd: Date | null
  }
  /** 本次调用是否发生 Phase 状态迁移（如 NOT_STARTED→IN_PROGRESS、→DONE） */
  phaseStatusChanged: boolean
  /** Phase DONE 时生成的催办待办条数 */
  todosCreated: number
  /** 收到 IM notify:push 的用户 */
  notifiedUserIds: string[]
  /** 项目进度（Phase 均值，动态计算） */
  projectProgress: number
}

type Tx = Prisma.TransactionClient

// ───────────────────────────── 工具 ─────────────────────────────

/** 解析日期字符串（YYYY-MM-DD 或 ISO）；非法值抛 400 */
function toDate(field: string, value: string): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new EngineError(400, `${field} 日期格式非法：${value}`)
  }
  return d
}

/** checklist JSON（模板 string[] / Phase [{text,checked,...}]）→ 全勾判定 */
function checklistAllChecked(checklist: unknown): boolean {
  if (checklist === null || checklist === undefined) return true
  let arr: unknown = checklist
  if (typeof checklist === 'string') {
    try {
      arr = JSON.parse(checklist)
    } catch {
      return true // 无法解析视为无检查项
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return true
  return arr.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as { checked?: unknown }).checked === true,
  )
}

/** 阶段编号：1 → PH01 */
export function phaseCodeOf(order: number): string {
  return `PH${String(order).padStart(2, '0')}`
}

// ───────────────────────────── 项目编号生成（§7.4）─────────────────────────────

/**
 * 生成下一个项目编号：DEMO + 签约年后两位 + 3位流水。
 * - 年份取 signedAt（签约日期）；未传时用当前日期
 * - 按年从 001 起编，取该年已有最大流水 +1（作废 CANCELLED 编号计入，不覆盖不复用）
 * - 兼容超过 3 位的流水（正则取全段数字），越过 999 后自然扩位
 * - 事务客户端内执行（tx 可直接传 prisma 单客户端）
 */
export async function nextProjectCode(
  tx: Tx,
  signedAt?: Date | null,
): Promise<string> {
  const year = (signedAt ?? new Date()).getFullYear()
  const yy = String(year).slice(-2)
  const prefix = `DEMO${yy}`
  const existing = await tx.project.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  })
  let max = 0
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  for (const p of existing) {
    const m = pattern.exec(p.code)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  let seq = max + 1
  // 极端并发/脏数据兜底：编号已被占用则继续 +1
  for (let i = 0; i < 1000; i++, seq++) {
    const code = `${prefix}${String(seq).padStart(3, '0')}`
    const taken = await tx.project.findUnique({ where: { code } })
    if (!taken) return code
  }
  throw new EngineError(500, `项目编号已用尽（${prefix} 段）`, 'INTERNAL_ERROR')
}

// ───────────────────────────── 岗位匹配 ─────────────────────────────

/**
 * ownerJobTitle → 组织内在职人员（User.jobTitle 冗余岗位名匹配，isActive=true）。
 * 多人取第一个在职的（createdAt 升序，入职先后）；匹配不到返回 null。
 */
export async function matchOwnerForJobTitle(
  tx: Tx,
  jobTitle: string,
): Promise<{ id: string; name: string; jobTitle: string | null } | null> {
  const user = await tx.user.findFirst({
    where: { jobTitle, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, jobTitle: true },
  })
  return user
}

// ───────────────────────────── 实例化五动作（§7.4）─────────────────────────────

/**
 * 创建项目并实例化流程（事务五动作，任一失败全回滚）。
 * 返回项目概览 + pendingAssignment（岗位匹配不到负责人的阶段）。
 */
export async function instantiateProject(
  userId: string,
  body: CreateProjectInput,
): Promise<InstantiateResult> {
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) {
    throw new EngineError(400, '项目名称不能为空')
  }

  return prisma.$transaction(
    async (tx) => {
      // ── 前置校验（事务内，失败即整体回滚，库中无残留）──
      if (body.customerId) {
        const customer = await tx.externalOrg.findUnique({
          where: { id: body.customerId },
          select: { id: true, name: true },
        })
        if (!customer) {
          throw new EngineError(400, `客户主体不存在：${body.customerId}`)
        }
      }

      const template = body.templateId
        ? await tx.processTemplate.findUnique({
            where: { id: body.templateId },
            include: { stages: { orderBy: { order: 'asc' } } },
          })
        : await tx.processTemplate.findFirst({
            where: { isDefault: true },
            include: { stages: { orderBy: { order: 'asc' } } },
          })
      if (!template) {
        throw new EngineError(400, '流程模板不存在（未指定 templateId 时需存在默认模板）')
      }
      if (template.stages.length === 0) {
        throw new EngineError(400, `流程模板「${template.name}」没有任何阶段，无法实例化`)
      }

      // 编号：显式传入则校验唯一；省略则按签约年自动生成
      const signedAt = body.signedAt ? toDate('signedAt', body.signedAt) : null
      let code = body.code?.trim() || ''
      if (code) {
        if (!/^DEMO\d{2}\d{3,}$/.test(code)) {
          throw new EngineError(400, '项目编号格式应为 DEMO+签约年后两位+流水（如 DEMO26001）')
        }
        const dup = await tx.project.findUnique({ where: { code } })
        if (dup) throw new EngineError(409, `项目编号 ${code} 已存在`, 'CONFLICT')
      } else {
        code = await nextProjectCode(tx, signedAt)
      }

      // stageOverrides 索引（order → 覆盖配置）
      const overrideByOrder = new Map<number, StageOverride>()
      for (const ov of body.stageOverrides ?? []) {
        if (!Number.isInteger(ov.order) || ov.order < 1) {
          throw new EngineError(400, `stageOverrides.order 非法：${ov.order}`)
        }
        overrideByOrder.set(ov.order, ov)
      }
      // override 指定的负责人必须真实存在且在职
      for (const ov of Array.from(overrideByOrder.values())) {
        if (ov.ownerId) {
          const u = await tx.user.findUnique({
            where: { id: ov.ownerId },
            select: { id: true, isActive: true },
          })
          if (!u || !u.isActive) {
            throw new EngineError(400, `阶段 ${phaseCodeOf(ov.order)} 覆盖指定的负责人不存在或已离职`)
          }
        }
      }

      // ── 动作①：建 Project ──
      const project = await tx.project.create({
        data: {
          code,
          name: body.name.trim(),
          description: body.description ?? null,
          contractNo: body.contractNo ?? null,
          location: body.location ?? null,
          amount:
            body.amount === undefined || body.amount === null || body.amount === ''
              ? null
              : new Prisma.Decimal(body.amount as string | number),
          customerId: body.customerId ?? null,
          signedAt,
          plannedStart: body.plannedStart ? toDate('plannedStart', body.plannedStart) : null,
          plannedEnd: body.plannedEnd ? toDate('plannedEnd', body.plannedEnd) : null,
          priority: body.priority ?? 'MEDIUM',
          templateId: template.id,
          createdBy: userId,
        },
      })

      // ── 动作②：按 TemplateStage 生成 Phase（岗位匹配 + override）──
      const pendingAssignment: InstantiateResult['pendingAssignment'] = []
      const autoMembers = new Map<string, { userId: string; title: string | null }>() // 阶段负责人自动入成员（去重）

      for (const stage of template.stages) {
        const override = overrideByOrder.get(stage.order)
        let ownerId: string | null = null
        let status: Phase['status'] = 'NOT_STARTED'
        let skippedNote: string | null = null

        if (override?.skip) {
          status = 'SKIPPED'
          skippedNote = '创建项目时按 stageOverrides 跳过'
        } else if (override?.ownerId) {
          ownerId = override.ownerId
        } else if (stage.ownerJobTitle) {
          const matched = await matchOwnerForJobTitle(tx, stage.ownerJobTitle)
          ownerId = matched?.id ?? null
          if (!matched) {
            pendingAssignment.push({
              order: stage.order,
              phaseCode: phaseCodeOf(stage.order),
              name: stage.name,
              ownerJobTitle: stage.ownerJobTitle,
            })
          }
        }
        if (ownerId) {
          const user = await tx.user.findUnique({
            where: { id: ownerId },
            select: { name: true, jobTitle: true },
          })
          if (!autoMembers.has(ownerId)) {
            autoMembers.set(ownerId, {
              userId: ownerId,
              title: user?.jobTitle ?? stage.ownerJobTitle ?? null,
            })
          }
        }

        // 模板 checklist（string[]）→ Phase checklist（[{text, checked, checkedBy, checkedAt}]）
        const checklistItems: Prisma.InputJsonValue[] = []
        if (Array.isArray(stage.checklist)) {
          for (const item of stage.checklist) {
            if (typeof item === 'string') {
              checklistItems.push({ text: item, checked: false, checkedBy: null, checkedAt: null })
            }
          }
        }

        await tx.phase.create({
          data: {
            projectId: project.id,
            code: phaseCodeOf(stage.order),
            name: stage.name,
            order: stage.order,
            status,
            ownerId,
            skippedNote,
            ...(checklistItems.length > 0 ? { checklist: checklistItems } : {}),
          },
        })
      }

      // ── 动作③：deliverables → FileCatalog（NN-阶段名）+ FileRequirement ──
      let requirementCount = 0
      let catalogCount = 0
      for (const stage of template.stages) {
        const override = overrideByOrder.get(stage.order)
        if (override?.skip) continue // 跳过的阶段不生成目录与条目
        const deliverables = Array.isArray(stage.deliverables)
          ? (stage.deliverables as unknown as DeliverableDef[])
          : []
        if (deliverables.length === 0) continue

        const code = phaseCodeOf(stage.order)
        const catalog = await tx.fileCatalog.create({
          data: {
            projectId: project.id,
            name: `${String(stage.order).padStart(2, '0')}-${stage.name}`,
            phaseCode: code,
            order: stage.order,
          },
        })
        catalogCount++

        // 阶段负责人 = 该阶段条目默认责任人（§7.4/§6.1：阶段负责人对交付物负责）
        const phase = await tx.phase.findUnique({
          where: { projectId_code: { projectId: project.id, code } },
          select: { ownerId: true },
        })

        let seq = 0
        for (const d of deliverables) {
          seq++
          await tx.fileRequirement.create({
            data: {
              projectId: project.id,
              catalogId: catalog.id,
              phaseCode: code,
              name: d.name,
              // code 生成规则 PROJ-PHxx-E-00N（E 段与 §7.7/§10.5 样例一致）
              code: `PROJ-${code}-E-${String(seq).padStart(3, '0')}`,
              required: d.required ?? true,
              ownerId: phase?.ownerId ?? null,
              purpose: d.purpose ?? null,
              scope: d.scope ?? 'PUBLIC',
              status: 'WAITING',
              // reviewerId 不落死值：按 §7.7 运行时默认阶段负责人（见文件头工程决策）
            },
          })
          requirementCount++
        }
      }

      // ── 动作④（成员部分）：创建者 OWNER + body.members + 阶段负责人自动并入 ──
      const memberSeen = new Set<string>()
      // 创建者恒 OWNER（body.members 中出现创建者时忽略其角色设置）
      await tx.projectMember.create({
        data: { projectId: project.id, userId, role: 'OWNER', title: '项目负责人' },
      })
      memberSeen.add(userId)

      for (const m of body.members ?? []) {
        const exists = await tx.user.findUnique({
          where: { id: m.userId },
          select: { id: true },
        })
        if (!exists) throw new EngineError(400, `项目成员不存在：${m.userId}`)
        if (memberSeen.has(m.userId)) continue
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            userId: m.userId,
            role: m.role ?? 'MEMBER',
            title: m.title ?? null,
          },
        })
        memberSeen.add(m.userId)
      }

      // ── 动作③b：成员个人交付物（2026-08-21 向导指定）──
      // 成员带 deliverables（需提交的工作文件清单）→ 生成「个人交付物」目录 + 条目，
      // ownerId = 该成员；催办/看板按 ownerId 分组
      const personalDeliverables: Array<{ userId: string; name: string }> = []
      for (const m of body.members ?? []) {
        if (!Array.isArray(m.deliverables) || m.deliverables.length === 0) continue
        for (const d of m.deliverables) {
          const name = d.trim()
          if (name) personalDeliverables.push({ userId: m.userId, name })
        }
      }
      if (personalDeliverables.length > 0) {
        const persCatalog = await tx.fileCatalog.create({
          data: {
            projectId: project.id,
            name: '个人交付物',
            phaseCode: null,
            order: 999,
          },
        })
        catalogCount++
        let pseq = 0
        for (const pd of personalDeliverables) {
          pseq++
          await tx.fileRequirement.create({
            data: {
              projectId: project.id,
              catalogId: persCatalog.id,
              phaseCode: null,
              name: pd.name,
              code: `PROJ-PERS-${String(pseq).padStart(3, '0')}`,
              required: true,
              ownerId: pd.userId,
              purpose: '个人交付物（创建向导指定）',
              scope: 'PUBLIC',
              status: 'WAITING',
            },
          })
          requirementCount++
        }
      }

      for (const m of Array.from(autoMembers.values())) {
        if (memberSeen.has(m.userId)) continue
        await tx.projectMember.create({
          data: {
            projectId: project.id,
            userId: m.userId,
            role: 'MEMBER',
            title: m.title,
          },
        })
        memberSeen.add(m.userId)
      }

      // ── 动作④：PROJECT_GROUP 会话 + 全部成员 + 欢迎消息 + NOTIFY ──
      const conversation = await tx.conversation.create({
        data: {
          type: 'PROJECT_GROUP',
          name: `${code} ${body.name.trim()}项目群`,
          projectId: project.id,
          createdBy: userId,
        },
      })
      const allMembers = await tx.projectMember.findMany({
        where: { projectId: project.id },
        select: { userId: true },
      })
      for (const m of allMembers) {
        await tx.conversationMember.create({
          data: {
            conversationId: conversation.id,
            userId: m.userId,
            role: m.userId === userId ? 'OWNER' : 'MEMBER',
          },
        })
      }

      await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          type: 'SYSTEM',
          content: `项目「${body.name.trim()}」（${code}）已创建，已按「${template.name}」实例化 ${template.stages.length} 个阶段、${requirementCount} 项交付文件清单。请相关同事关注各自负责的阶段与文件提交。`,
        },
      })

      // PG NOTIFY（§9.4）：事务提交时投递；回滚不发出
      // ① conv:created：被拉入新会话（im-server 按成员房间分发）
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'conv:created',
        conversation: {
          id: conversation.id,
          type: 'PROJECT_GROUP',
          name: conversation.name,
          projectId: project.id,
          createdBy: userId,
          members: allMembers.map((m) => ({ userId: m.userId })),
        },
      })})`
      // ② message:new：欢迎消息广播（im-server 拉最新一条广播到会话房间）
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'message:new',
        conversationId: conversation.id,
      })})`

      return {
        project,
        phaseCount: template.stages.length,
        catalogCount,
        requirementCount,
        conversationId: conversation.id,
        memberCount: memberSeen.size,
        pendingAssignment,
      }
    },
    { timeout: 30_000 },
  )
}

// ───────────────────────────── 状态联动（§7.5）─────────────────────────────

/**
 * 任务状态联动入口：任务创建/更新后由路由调用。
 * 四规则：
 *   1. 任一子任务开始 → Phase IN_PROGRESS + actualStart
 *   2. 全部任务 DONE（CANCELLED 剔除分母）+ checklist 全勾 → Phase DONE + actualEnd
 *   3. Phase → DONE 时，对该阶段 WAITING 文件条目生成催办待办 + IM notify:push
 *   4. progress 回写（DONE 任务占比 → Phase.progress）
 */
export async function onTaskChanged(taskId: string): Promise<TaskLinkageResult> {
  return prisma.$transaction(
    async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { id: true, phaseId: true, projectId: true, status: true, startedAt: true },
      })
      if (!task) throw new EngineError(404, `任务不存在：${taskId}`, 'NOT_FOUND')
      if (!task.phaseId) {
        // 历史任务未挂阶段：仅回写项目进度（Phase 均值不变）
        const progress = await computeProjectProgressTx(tx, task.projectId)
        return emptyResult(progress)
      }

      const phase = await tx.phase.findUnique({ where: { id: task.phaseId } })
      if (!phase) throw new EngineError(404, `阶段不存在：${task.phaseId}`, 'NOT_FOUND')

      const tasks = await tx.task.findMany({
        where: { phaseId: phase.id },
        select: { status: true, startedAt: true },
      })
      // CANCELLED 任务剔除出分母（取消的任务不算待完成）
      const effective = tasks.filter((t) => t.status !== 'CANCELLED')
      const doneCount = effective.filter((t) => t.status === 'DONE').length
      const startedCount = effective.filter(
        (t) =>
          t.status === 'IN_PROGRESS' ||
          t.status === 'REVIEW' ||
          t.status === 'DONE' ||
          t.startedAt !== null,
      ).length

      const prevStatus = phase.status
      const data: Prisma.PhaseUpdateInput = {}
      let toDone = false

      // 规则 4：progress = DONE 任务完成率
      const progress = effective.length > 0
        ? Math.round((doneCount / effective.length) * 100)
        : phase.progress
      if (progress !== phase.progress) data.progress = progress

      // 规则 1：任一子任务开始 → IN_PROGRESS + actualStart（状态只前进）
      if (
        startedCount > 0 &&
        (phase.status === 'NOT_STARTED' || phase.status === 'PAUSED')
      ) {
        data.status = 'IN_PROGRESS'
        data.actualStart = phase.actualStart ?? new Date()
      }

      // 规则 2：全部任务 DONE + checklist 全勾 → DONE + actualEnd
      const allDone =
        effective.length > 0 && doneCount === effective.length
      if (
        allDone &&
        checklistAllChecked(phase.checklist) &&
        phase.status !== 'DONE' &&
        phase.status !== 'SKIPPED'
      ) {
        data.status = 'DONE'
        data.actualEnd = new Date()
        data.actualStart = phase.actualStart ?? new Date()
        toDone = true
      }

      let updated = phase
      if (Object.keys(data).length > 0) {
        updated = await tx.phase.update({ where: { id: phase.id }, data })
      }
      const phaseStatusChanged = updated.status !== prevStatus

      // 规则 3：Phase → DONE 时催办该阶段 WAITING 文件条目（待办 + IM notify）
      let todosCreated = 0
      const notifiedUserIds: string[] = []
      if (toDone) {
        const reminded = await remindWaitingRequirements(tx, phase.projectId, phase.code)
        todosCreated = reminded.todosCreated
        notifiedUserIds.push(...reminded.notifiedUserIds)
      }

      const projectProgress = await computeProjectProgressTx(tx, phase.projectId)
      return {
        affected: true,
        phase: {
          id: updated.id,
          code: updated.code,
          status: updated.status,
          progress: updated.progress,
          actualStart: updated.actualStart,
          actualEnd: updated.actualEnd,
        },
        phaseStatusChanged,
        todosCreated,
        notifiedUserIds,
        projectProgress,
      }
    },
    { timeout: 30_000 },
  )

  function emptyResult(projectProgress: number): TaskLinkageResult {
    return {
      affected: false,
      phase: {
        id: '',
        code: '',
        status: 'NOT_STARTED',
        progress: 0,
        actualStart: null,
        actualEnd: null,
      },
      phaseStatusChanged: false,
      todosCreated: 0,
      notifiedUserIds: [],
      projectProgress,
    }
  }
}

// ───────────────────────────── Phase→DONE 催办（§7.5 规则 3，PATCH /phases/:id 复用）──────────────────────────────

/**
 * Phase 置 DONE 时：对该阶段 WAITING 文件条目逐条生成 HIGH 待办 + IM notify:push。
 * ownerId 为空的条目挂到项目负责人（ProjectMember OWNER）。
 * 须在事务内调用（onTaskChanged 规则 3 与 PATCH /phases/:id {status:DONE} 共用）。
 */
export async function remindWaitingRequirements(
  tx: Tx,
  projectId: string,
  phaseCode: string,
): Promise<{ todosCreated: number; notifiedUserIds: string[] }> {
  const phase = await tx.phase.findUnique({
    where: { projectId_code: { projectId, code: phaseCode } },
    select: { code: true, name: true },
  })
  if (!phase) return { todosCreated: 0, notifiedUserIds: [] }

  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { code: true },
  })
  const reqs = await tx.fileRequirement.findMany({
    where: { projectId, phaseCode, status: 'WAITING' },
    select: { id: true, name: true, ownerId: true },
  })
  // ownerId 为空的条目挂到项目负责人（工程决策，见文件头）
  let projectOwnerId: string | null = null
  if (reqs.some((r) => !r.ownerId)) {
    const owner = await tx.projectMember.findFirst({
      where: { projectId, role: 'OWNER' },
      select: { userId: true },
    })
    projectOwnerId = owner?.userId ?? null
  }
  const notifiedUserIds: string[] = []
  for (const req of reqs) {
    const target = req.ownerId ?? projectOwnerId
    if (!target) continue
    await tx.todoItem.create({
      data: {
        userId: target,
        title: `【催办】${project?.code ?? ''} ${phase.name}：请提交「${req.name}」`,
        sourceType: 'FILE_REQ',
        sourceId: req.id,
        link: `/files?projectId=${projectId}&requirementId=${req.id}`,
        priority: 'HIGH',
      },
    })
    notifiedUserIds.push(target)
    await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'notify:push',
      userId: target,
      title: `文件催办：${req.name}`,
      body: `项目 ${project?.code ?? ''} 阶段「${phase.name}」已完成，请尽快提交「${req.name}」`,
      link: `/files?projectId=${projectId}&requirementId=${req.id}`,
    })})`
  }
  return { todosCreated: notifiedUserIds.length, notifiedUserIds }
}

/**
 * 校验阶段是否允许置 DONE（§7.5「允许置 DONE」前置条件）。
 * 供 PATCH /phases/:id 路由（P1-2）与前端提示复用。
 */
export async function canMarkPhaseDone(
  phaseId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const phase = await prisma.phase.findUnique({ where: { id: phaseId } })
  if (!phase) return { ok: false, reason: '阶段不存在' }
  if (phase.status === 'SKIPPED') return { ok: false, reason: '阶段已跳过' }

  const tasks = await prisma.task.findMany({
    where: { phaseId },
    select: { status: true },
  })
  const effective = tasks.filter((t) => t.status !== 'CANCELLED')
  if (effective.length === 0) return { ok: false, reason: '阶段下没有有效任务' }
  const undone = effective.filter((t) => t.status !== 'DONE').length
  if (undone > 0) {
    return { ok: false, reason: `尚有 ${undone} 个任务未完成（${effective.length - undone}/${effective.length}）` }
  }
  if (!checklistAllChecked(phase.checklist)) {
    return { ok: false, reason: '验收检查项未全部勾选' }
  }
  return { ok: true }
}

// ───────────────────────────── 项目进度（Phase 均值）─────────────────────────────

/**
 * 项目进度 = 各阶段 progress 均值（§7.5「task 完成率→Phase，Phase 均值→Project」）。
 * SKIPPED 阶段不计入分母（可跳过阶段不应封顶项目进度上限）。
 * Project 无 progress 持久字段（§5 schema），由本函数动态计算，供 tree/详情 API 使用。
 */
export async function computeProjectProgress(projectId: string): Promise<number> {
  return computeProjectProgressTx(prisma, projectId)
}

async function computeProjectProgressTx(tx: Tx, projectId: string): Promise<number> {
  const phases = await tx.phase.findMany({
    where: { projectId, status: { not: 'SKIPPED' } },
    select: { progress: true },
  })
  if (phases.length === 0) return 0
  const sum = phases.reduce((acc, p) => acc + p.progress, 0)
  return Math.round(sum / phases.length)
}

// ───────────────────────────── 手动催办个人交付物（2026-08-21）──────────────────────────────

/**
 * 手动催办指定交付物条目：对每条目责任人（ownerId）生成 HIGH 待办 + IM 通知。
 * 用于交付物看板的「催办」按钮（管理员/PM 对未提交成员主动催办）。
 */
export async function urgeRequirements(
  tx: Tx,
  projectId: string,
  requirementIds: string[],
  urgedById: string,
): Promise<{ notifiedUserIds: string[] }> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { code: true, name: true },
  })
  const reqs = await tx.fileRequirement.findMany({
    where: { id: { in: requirementIds }, projectId },
    select: { id: true, name: true, ownerId: true, phaseCode: true },
  })
  // ownerId 为空 → 挂项目负责人
  let projectOwnerId: string | null = null
  if (reqs.some((r) => !r.ownerId)) {
    const owner = await tx.projectMember.findFirst({
      where: { projectId, role: 'OWNER' },
      select: { userId: true },
    })
    projectOwnerId = owner?.userId ?? null
  }
  const notifiedUserIds: string[] = []
  const seen = new Set<string>()
  for (const req of reqs) {
    const target = req.ownerId ?? projectOwnerId
    if (!target || seen.has(target)) continue
    seen.add(target)
    const phaseLabel = req.phaseCode ? `（阶段 ${req.phaseCode}）` : '（个人交付物）'
    await tx.todoItem.create({
      data: {
        userId: target,
        title: `【催办】${project?.code ?? ''} ${phaseLabel}：请提交「${req.name}」`,
        sourceType: 'FILE_REQ',
        sourceId: req.id,
        link: `/files?projectId=${projectId}&requirementId=${req.id}`,
        priority: 'HIGH',
      },
    })
    // 催办记录（2026-08-22 工作台「我的催办」）：持久化发起人/被催人，支持双向展示
    await tx.urgeRecord.create({
      data: {
        projectId,
        projectCode: project?.code ?? '',
        requirementId: req.id,
        requirementName: req.name,
        urgedById,
        targetUserId: target,
        status: 'ACTIVE',
      },
    })
    notifiedUserIds.push(target)
    await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'notify:push',
      userId: target,
      title: `文件催办：${req.name}`,
      body: `项目 ${project?.code ?? ''} 中「${req.name}」尚未提交，请尽快上传`,
      link: `/files?projectId=${projectId}&requirementId=${req.id}`,
    })})`
  }
  return { notifiedUserIds }
}
