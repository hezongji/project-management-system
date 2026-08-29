/**
 * /api/phases/[id] —— 依据《开发文档-项目管理系统重构》§7.5
 *
 * PATCH  阶段 edit（权限引擎 can('edit', PHASE)：项目 OWNER / 项目 MANAGER / ADMIN，§6.1）
 *        { status?, ownerId?, plannedStart?, plannedEnd?, checklist? }
 * DELETE 阶段 delete（同 edit 权限；删除工程第 2 棒，§2）：引用保护（子任务/文件条目 >0
 *        → 400 拒绝）；可删时级联阶段相关文件条目（含文件）/目录/待办/通知/催办；
 *        归档项目冻结不可删；logDelete 审计（ActivityLog.projectId 保留，项目仍在）
 *
 * 规则：
 *  - status=DONE：canMarkPhaseDone 前置校验（全部任务 DONE + checklist 全勾），
 *    通过 → actualEnd=now + actualStart 回填 + 催办该阶段 WAITING 文件条目（§7.5 规则 3，
 *    复用 phase-engine.remindWaitingRequirements）+ ActivityLog phase.done
 *  - status=IN_PROGRESS：actualStart 回填（已有值不覆盖）
 *  - status=SKIPPED：拒绝，必须走 POST /phases/:id/skip（skippedNote 必填）
 *  - ownerId 改派：校验用户存在且在职；ActivityLog phase.reassign 记 [旧, 新]
 *  - checklist：整组替换 [{ text, checked, checkedBy, checkedAt }]
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, permsOf, batchPermsOf, invalidateProject } from '@/lib/permission'
import { logDelete } from '@/lib/delete-helpers'

// 批量权限缺失时的兜底空权限（2026-08-22 P1-4）
function blankPermsLike() {
  return { view: false, edit: false, upload: false, approve: false, download: false, assign: false, archive: false }
}
import { canMarkPhaseDone, remindWaitingRequirements } from '@/lib/phase-engine'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const dateStr = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: '日期格式非法' })

const patchSchema = z.object({
  status: z
    .enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'PAUSED', 'SKIPPED'])
    .optional(),
  ownerId: z.string().trim().min(1).nullable().optional(),
  plannedStart: dateStr.nullable().optional(),
  plannedEnd: dateStr.nullable().optional(),
  checklist: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(200),
        checked: z.boolean(),
        checkedBy: z.string().nullable().optional(),
        checkedAt: z.string().nullable().optional(),
      }),
    )
    .optional(),
  // 单个检查项勾选（前端看板/头区复选框走此字段，§8.2②）
  checklistItem: z
    .object({
      index: z.number().int().min(0),
      checked: z.boolean(),
    })
    .optional(),
})

// ───────────────────────────── 检查项解析（Json → 对象数组）──────────────────────────────

/** Phase.checklist（Json）→ [{ text, checked, checkedBy, checkedAt }]；非法结构容错为 [] */
function parseChecklist(raw: unknown): {
  text: string
  checked: boolean
  checkedBy: string | null
  checkedAt: string | null
}[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr.flatMap((item) => {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const o = item as Record<string, unknown>
      return [
        {
          text: String(o.text ?? ''),
          checked: o.checked === true,
          checkedBy: typeof o.checkedBy === 'string' ? o.checkedBy : null,
          checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : null,
        },
      ]
    }
    return []
  })
}

// ───────────────────────────── GET：下钻聚合（§7.5 / §8.2② 四区数据源）──────────────────────────────

/** 看板四列（§8.2② 左区）；CANCELLED 不进看板，单独折叠提示 */
const BOARD_COLUMNS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const

export const GET = apiHandler<Ctx>(async (request, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PHASE', id: id })

  const phase = await prisma.phase.findUnique({
    where: { id: id },
    include: {
      owner: { select: { id: true, name: true, email: true, avatar: true, jobTitle: true } },
      project: { select: { id: true, code: true, name: true, status: true, isArchived: true } },
    },
  })
  if (!phase) throw ApiError.notFound('阶段不存在')

  const projectId = phase.projectId

  const [tasks, requirements, members, phasePerms, canMarkDone] = await Promise.all([
    prisma.task.findMany({
      where: { phaseId: phase.id },
      include: {
        assignee: { select: { id: true, name: true, avatar: true } },
        _count: { select: { annotations: true, revisions: true, comments: true } },
      },
      orderBy: [{ status: 'asc' }, { id: 'asc' }],
    }),
    prisma.fileRequirement.findMany({
      where: { projectId, phaseCode: phase.code },
      include: {
        owner: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        catalog: { select: { id: true, name: true } },
        files: {
          include: { uploadedBy: { select: { id: true, name: true } } },
          orderBy: { version: 'desc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      select: {
        userId: true,
        role: true,
        title: true,
        user: { select: { id: true, name: true, avatar: true, jobTitle: true } },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    }),
    permsOf(user.userId, { type: 'PHASE', id: phase.id }),
    canMarkPhaseDone(phase.id),
  ])

  // 批量权限（2026-08-22 P1-4 修复）：N 次 permsOf → 1 次 batchPermsOf（消除 N+1）
  const taskPerms = await batchPermsOf(
    user.userId,
    tasks.map((t) => ({
      type: 'TASK' as const,
      id: t.id,
      projectId: t.projectId,
      phaseId: t.phaseId,
      assigneeId: t.assigneeId,
    })),
  )
  // 任务卡（附加按钮级 permissions.view/edit，§4.7）
  const taskCards = tasks.map((t) => {
    const perms = taskPerms.get(t.id) ?? blankPermsLike()
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId,
      assignee: t.assignee,
      dueDate: t.dueDate,
      revision: t.revision,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      _count: t._count,
      permissions: { view: perms.view, edit: perms.edit },
    }
  })

  const taskColumns = {
    TODO: taskCards.filter((t) => t.status === 'TODO'),
    IN_PROGRESS: taskCards.filter((t) => t.status === 'IN_PROGRESS'),
    REVIEW: taskCards.filter((t) => t.status === 'REVIEW'),
    DONE: taskCards.filter((t) => t.status === 'DONE'),
  }
  const cancelledTasks = taskCards.filter((t) => t.status === 'CANCELLED')

  // 批量权限（文件条目，2026-08-22 P1-4 修复）
  const reqPerms = await batchPermsOf(
    user.userId,
    requirements.map((r) => ({
      type: 'FILE_REQ' as const,
      id: r.id,
      projectId: r.projectId,
      ownerId: r.ownerId,
      scope: r.scope,
      scopeRefs: r.scopeRefs ?? undefined,
      phaseCode: r.phaseCode,
    })),
  )
  // 文件条目（含 files 版本数组 + 按钮级 permissions，§7.7 条目对象）
  const fileRequirements = requirements.map((r) => {
    const perms = reqPerms.get(r.id) ?? blankPermsLike()
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      required: r.required,
      ownerId: r.ownerId,
      owner: r.owner,
      purpose: r.purpose,
      dueDate: r.dueDate,
      status: r.status,
      reviewerId: r.reviewerId,
      reviewer: r.reviewer,
      catalog: r.catalog,
      files: r.files.map((f) => ({
        id: f.id,
        name: f.name,
        originalName: f.originalName,
        size: f.size,
        mimeType: f.mimeType,
        version: f.version,
        uploadedById: f.uploadedById,
        uploadedBy: f.uploadedBy,
        createdAt: f.createdAt,
      })),
      permissions: { view: perms.view, upload: perms.upload, approve: perms.approve },
    }
  })

  // 成员（含 isPhaseOwner 标记，§8.2② 头区改派候选）
  const memberList = members.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    avatar: m.user.avatar,
    jobTitle: m.user.jobTitle,
    role: m.role,
    title: m.title,
    isPhaseOwner: m.userId === phase.ownerId,
  }))

  // 阶段动态：ActivityLog 按 detail.phaseId 过滤（§8.2② 底区）
  const activities = await prisma.activityLog.findMany({
    where: {
      projectId,
      detail: { path: ['phaseId'], equals: phase.id },
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return ok({
    phase: {
      id: phase.id,
      projectId: phase.projectId,
      code: phase.code,
      name: phase.name,
      order: phase.order,
      status: phase.status,
      ownerId: phase.ownerId,
      owner: phase.owner,
      plannedStart: phase.plannedStart,
      plannedEnd: phase.plannedEnd,
      actualStart: phase.actualStart,
      actualEnd: phase.actualEnd,
      progress: phase.progress,
      skippedNote: phase.skippedNote,
      checklist: phase.checklist,
    },
    project: phase.project,
    taskColumns,
    cancelledTasks,
    fileRequirements,
    members: memberList,
    activities,
    permissions: phasePerms,
    canMarkDone,
  })
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'edit', { type: 'PHASE', id: id })

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchSchema.parse(raw)
  if (Object.keys(body).length === 0) {
    throw ApiError.badRequest('没有可更新的字段')
  }

  const phase = await prisma.phase.findUnique({ where: { id: id } })
  if (!phase) throw ApiError.notFound('阶段不存在')

  // SKIPPED 必须走专用接口（skippedNote 必填，§7.5）
  if (body.status === 'SKIPPED') {
    throw ApiError.badRequest('跳过阶段请使用 POST /api/phases/:id/skip（需填写跳过原因）')
  }

  // 置 DONE 前置校验（§7.5：全部任务 DONE + checklist 全勾）
  if (body.status === 'DONE' && phase.status !== 'DONE') {
    const check = await canMarkPhaseDone(id)
    if (!check.ok) {
      throw ApiError.badRequest(`阶段尚不能标记完成：${check.reason ?? '前置条件不满足'}`)
    }
  }

  // 改派负责人：校验目标用户存在且在职
  if (body.ownerId && body.ownerId !== phase.ownerId) {
    const target = await prisma.user.findUnique({
      where: { id: body.ownerId },
      select: { id: true, isActive: true, name: true },
    })
    if (!target || !target.isActive) {
      throw ApiError.badRequest('新负责人不存在或已离职')
    }
  }

  const data: Record<string, unknown> = {}
  const detail: Record<string, [unknown, unknown]> = {}
  if (body.status !== undefined) {
    data.status = body.status
    if (body.status === 'DONE' && phase.status !== 'DONE') {
      data.actualEnd = new Date()
      data.actualStart = phase.actualStart ?? new Date()
      detail.status = [phase.status, body.status]
    } else if (body.status === 'IN_PROGRESS') {
      data.actualStart = phase.actualStart ?? new Date()
      detail.status = [phase.status, body.status]
    } else if (body.status !== phase.status) {
      detail.status = [phase.status, body.status]
    }
  }
  if (body.ownerId !== undefined) {
    data.ownerId = body.ownerId
    if (body.ownerId !== phase.ownerId) detail.ownerId = [phase.ownerId, body.ownerId]
  }
  if (body.plannedStart !== undefined) {
    data.plannedStart = body.plannedStart === null ? null : new Date(body.plannedStart)
  }
  if (body.plannedEnd !== undefined) {
    data.plannedEnd = body.plannedEnd === null ? null : new Date(body.plannedEnd)
  }
  if (body.checklist !== undefined) {
    data.checklist = body.checklist.map((c) => ({
      text: c.text,
      checked: c.checked,
      checkedBy: c.checkedBy ?? (c.checked ? user.userId : null),
      checkedAt: c.checkedAt ?? (c.checked ? new Date().toISOString() : null),
    }))
  }
  // 单个检查项勾选（§8.2② 头区复选框：只改对应 index，其余保留）
  if (body.checklistItem !== undefined) {
    const current = parseChecklist(phase.checklist)
    const { index, checked } = body.checklistItem
    if (index < 0 || index >= current.length) {
      throw ApiError.badRequest('检查项索引越界')
    }
    data.checklist = current.map((c, i) =>
      i === index
        ? {
            text: c.text,
            checked,
            checkedBy: checked ? user.userId : null,
            checkedAt: checked ? new Date().toISOString() : null,
          }
        : c,
    )
  }

  const toDone =
    body.status === 'DONE' && phase.status !== 'DONE' && phase.status !== 'SKIPPED'

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.phase.update({
      where: { id: id },
      data,
      include: { owner: { select: { id: true, name: true, avatar: true } } },
    })
    // 置 DONE → 催办该阶段 WAITING 文件条目（§7.5 规则 3）
    let todosCreated = 0
    if (toDone) {
      const reminded = await remindWaitingRequirements(tx, phase.projectId, phase.code)
      todosCreated = reminded.todosCreated
    }
    await tx.activityLog.create({
      data: {
        projectId: phase.projectId,
        userId: user.userId,
        action: toDone ? 'phase.done' : 'phase.update',
        detail: {
          phaseId: phase.id,
          phaseCode: phase.code,
          ...(toDone ? { ...detail, todosCreated } : detail),
        } as unknown as Prisma.InputJsonValue,
      },
    })
    return { row, todosCreated }
  })

  invalidateProject(phase.projectId)

  return ok({
    phase: updated.row,
    todosCreated: updated.todosCreated,
    message:
      body.status === 'DONE'
        ? updated.todosCreated > 0
          ? `阶段已完成；已生成 ${updated.todosCreated} 条文件催办待办`
          : '阶段已完成'
        : '阶段已更新',
  })
})

// ───────────────────── DELETE：删除阶段（删除工程第 2 棒，§2/§2.3/§2.5）─────────────────────

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  // 权限复用权限引擎 edit（PHASE）= 项目 OWNER / MANAGER / ADMIN；
  // 归档项目非 ADMIN 已被终审拦截（isArchived → edit=false → 403）
  await requireCan(user.userId, 'edit', { type: 'PHASE', id: id })

  const phase = await prisma.phase.findUnique({
    where: { id: id },
    select: { id: true, code: true, name: true, projectId: true },
  })
  if (!phase) throw ApiError.notFound('阶段不存在')

  // 状态限制：归档项目冻结（ADMIN 同拦，与项目 DELETE 口径一致，需先解除归档）
  const project = await prisma.project.findUnique({
    where: { id: phase.projectId },
    select: { isArchived: true },
  })
  if (project?.isArchived) {
    throw ApiError.badRequest('项目已归档（只读），请先解除归档后再删除阶段')
  }

  // 引用保护（§2.3，assertDeletable 同语义；文案按任务书给阶段场景的替代方案）：
  // 子任务 / 文件条目 > 0 时拒绝，需先清理或直接删项目
  const [taskCount, fileEntryCount] = await Promise.all([
    prisma.task.count({ where: { phaseId: phase.id } }),
    prisma.fileRequirement.count({
      where: { projectId: phase.projectId, phaseCode: phase.code },
    }),
  ])
  const blocking = taskCount + fileEntryCount
  if (blocking > 0) {
    throw ApiError.badRequest(
      `该阶段存在 ${blocking} 条任务/文件，请先清理或直接删除项目`,
    )
  }

  const deleted = await prisma.$transaction(async (tx) => {
    // 阶段关联定位：phaseCode 命中的文件条目 + 阶段绑定目录（含其下条目）
    const [requirements, catalogs] = await Promise.all([
      tx.fileRequirement.findMany({
        where: { projectId: phase.projectId, phaseCode: phase.code },
        select: { id: true },
      }),
      tx.fileCatalog.findMany({
        where: { projectId: phase.projectId, phaseCode: phase.code },
        select: { id: true },
      }),
    ])
    const requirementIds = requirements.map((r) => r.id)

    // m4 修复：递归收集目录及其全部子目录（FileCatalog 自引用 parentId，避免删父后子目录被 SetNull 顶起残留）
    const catalogIds: string[] = catalogs.map((c) => c.id)
    let frontier = [...catalogIds]
    while (frontier.length > 0) {
      const children = await tx.fileCatalog.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      })
      const fresh = children.map((c) => c.id).filter((id) => !catalogIds.includes(id))
      if (fresh.length === 0) break
      catalogIds.push(...fresh)
      frontier = fresh
    }

    // 文件先删（File.requirementId 为 SET NULL，随条目删会留孤儿记录）
    const files = requirementIds.length
      ? await tx.file.deleteMany({ where: { requirementId: { in: requirementIds } } })
      : { count: 0 }
    // 催办记录（UrgeRecord.requirementId 无 FK，显式清理防空挂）
    const urgeRecords = requirementIds.length
      ? await tx.urgeRecord.deleteMany({ where: { requirementId: { in: requirementIds } } })
      : { count: 0 }
    // 待办：PHASE 本阶段 + FILE_REQ 阶段条目（TASK 类引用已被阻断不存在）
    const todoItems = await tx.todoItem.deleteMany({
      where: {
        OR: [
          { sourceType: 'PHASE', sourceId: phase.id },
          ...requirementIds.map((id) => ({ sourceType: 'FILE_REQ' as const, sourceId: id })),
        ],
      },
    })
    // 通知：阶段下钻链 + 文件条目链（任务链已无）
    const notifications = await tx.notification.deleteMany({
      where: {
        OR: [
          { link: { startsWith: `/projects/${phase.projectId}/phases/${phase.id}` } },
          ...requirementIds.map(
            (id) => ({ link: `/files?projectId=${phase.projectId}&requirementId=${id}` }),
          ),
        ],
      },
    })

    // 目录先删（其下条目 Cascade）；再兕底删 phaseCode 命中但目录未绑定的条目
    const fileCatalogs = catalogIds.length
      ? await tx.fileCatalog.deleteMany({ where: { id: { in: catalogIds } } })
      : { count: 0 }
    const fileRequirements = await tx.fileRequirement.deleteMany({
      where: { projectId: phase.projectId, phaseCode: phase.code },
    })

    // conversationMember：阶段与会话无直接关联（Conversation 仅到 projectId 粒度，
    // 且会话/消息按任务书保留），故阶段删除不动会话成员
    await tx.phase.delete({ where: { id: phase.id } })

    return {
      files: files.count,
      urgeRecords: urgeRecords.count,
      todoItems: todoItems.count,
      notifications: notifications.count,
      fileCatalogs: fileCatalogs.count,
      fileRequirements: fileRequirements.count,
    }
  })

  invalidateProject(phase.projectId)

  // 审计留痕（§2.5）：项目仍在，ActivityLog.projectId 保留指向
  await logDelete(
    user.userId,
    'phase',
    phase.id,
    { phaseCode: phase.code, phaseName: phase.name, ...deleted },
    phase.projectId,
  )

  return ok(
    { id: phase.id, code: phase.code, name: phase.name, deleted },
    '阶段已删除',
  )
})
