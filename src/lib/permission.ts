/**
 * 权限引擎（三层合成）—— 依据《开发文档-项目管理系统重构》§6
 *
 * 判定流程（§6.1）：
 *   1. 取用户全局角色（ADMIN → true 直通，不经后续步骤）
 *   2. 项目角色基线（资源所属项目）：
 *        OWNER → 项目内全允许；MANAGER → edit/assign；
 *        阶段负责人(Phase.ownerId) → 该阶段内 task.* / file.approve；
 *        任务负责人(Task.assigneeId) → 该 task edit/annotate；
 *        MEMBER → view；VIEWER → view
 *   3. 资源 ACL 合并（∪ 追加授权；不设减权）
 *   4. 文件条目范围终审（仅 FILE_REQ 资源的 view/download）：
 *        scope=PUBLIC     → 项目成员 view/download
 *        scope=RESTRICTED → scopeRefs.userIds ∪ scopeRefs.deptIds 命中者 view/download
 *        scope=PRIVATE    → ownerId + 项目 OWNER
 *
 * 工程化补充说明（文档未明示、按字面语义落地，均可在 P0-2 报告中追溯）：
 *   - 未登录（userId 为空）/ 用户不存在 / isActive=false → 一律拒绝
 *   - 全局 PROJECT_MANAGER 仅在 API 层控制「创建项目」（§7.4），can() 不直通
 *   - 基线 view 是所有项目成员的底线（MEMBER/VIEWER→view，故 MANAGER/OWNER 隐含 view）
 *   - 「任务负责人 edit/annotate」落地为 view+edit：能改不能看将产生荒谬组合
 *   - 「阶段负责人 file.approve」落地为 approve+view：审阅文件必须先能看
 *   - 「task.*」字面为该阶段内任务的全部 8 个 Action
 *   - 归档项目(isArchived)只读：非 ADMIN 仅保留 view/download，其余一律拒绝
 *   - 范围终审为「终审」：对 FILE_REQ 的 view/download 否决基线/ACL 的授权结论
 *     （PRIVATE 的封闭名单「ownerId + 项目 OWNER」即此语义；ADMIN 已在步骤 1 直通）
 *   唯一豁免：【定向审阅人】（阶段负责人命中该条目 / ACL 显式授 approve 者）必然可见可下载
 *     ——能审不能看属逻辑矛盾；但 OWNER 通配基线里的 approve 不算定向审阅，仍受终审否决
 *     故 view/download = 范围名单 ∪ {定向审阅人}
 *   - ADMIN 直通前先校验资源存在（资源/项目不存在 → 拒绝，不授权幽灵资源）
 *
 * 缓存（§6.2）：进程内 LRU，key = `userId:resourceType:resourceId`，
 *   TTL 5min；权限/用户/项目变更时调用 invalidatePerms / invalidateProject 主动失效。
 */

import { prisma } from './prisma'
import type { Prisma, ResType, FileScope } from '@prisma/client'

// ───────────────────────────── 类型与常量 ─────────────────────────────

/** 可判定的动作全集（§6.2） */
export type Action =
  | 'view'
  | 'edit'
  | 'delete'
  | 'assign'
  | 'upload'
  | 'download'
  | 'approve'
  | 'archive'

/** 资源定位（§6.2） */
export type Res = { type: ResType; id: string }

export type Perms = Record<Action, boolean>

export const ACTIONS: readonly Action[] = [
  'view',
  'edit',
  'delete',
  'assign',
  'upload',
  'download',
  'approve',
  'archive',
] as const

const VIEW_ONLY: readonly Action[] = ['view'] as const

/**
 * 通用 API 错误：requireCan 不通过时抛出 ApiError(403)。
 * 路由层捕获后映射为统一错误响应体。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'FORBIDDEN') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// ───────────────────────────── LRU 缓存 ─────────────────────────────

interface CacheEntry {
  perms: Perms
  /** 资源所属项目 id（资源不存在/用户无效时为 null），供 invalidateProject 精准失效 */
  projectId: string | null
  expiresAt: number
}

interface CacheConfig {
  /** TTL（毫秒），默认 5 分钟（§6.2） */
  ttlMs: number
  /** 最大条目数（LRU 容量上限） */
  maxEntries: number
}

let cacheConfig: CacheConfig = { ttlMs: 5 * 60 * 1000, maxEntries: 5000 }

/** 运行时可调参（测试与运维降级用） */
export function configurePermissionCache(cfg: Partial<CacheConfig>): void {
  cacheConfig = { ...cacheConfig, ...cfg }
}

/** Map 迭代序 = 插入序；命中即重插实现 LRU 淘汰 */
const permCache = new Map<string, CacheEntry>()

const cacheKey = (userId: string, res: Res): string =>
  `${userId}:${res.type}:${res.id}`

function cacheGet(key: string): CacheEntry | undefined {
  const entry = permCache.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    permCache.delete(key)
    return undefined
  }
  // LRU：命中移到队尾
  permCache.delete(key)
  permCache.set(key, entry)
  return entry
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (permCache.has(key)) permCache.delete(key)
  permCache.set(key, entry)
  while (permCache.size > cacheConfig.maxEntries) {
    const oldest = permCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    permCache.delete(oldest)
  }
}

/** 用户级失效：权限变更（角色调整/成员增删/ACL 变更涉及人）后调用；不传参=清空全部 */
export function invalidatePerms(userId?: string): void {
  if (userId === undefined || userId === '') {
    permCache.clear()
    return
  }
  const prefix = `${userId}:`
  for (const key of Array.from(permCache.keys())) {
    if (key.startsWith(prefix)) permCache.delete(key)
  }
}

/** 项目级失效：项目归档/成员批量调整/模板重建等波及整个项目的变更后调用 */
export function invalidateProject(projectId: string): void {
  for (const [key, entry] of Array.from(permCache.entries())) {
    if (entry.projectId === projectId) permCache.delete(key)
  }
}

// ───────────────────────────── 内部工具 ─────────────────────────────

function blankPerms(): Perms {
  const perms = {} as Record<string, boolean>
  for (const a of ACTIONS) perms[a] = false
  return perms as Perms
}

function fullPerms(): Perms {
  const perms = {} as Record<string, boolean>
  for (const a of ACTIONS) perms[a] = true
  return perms as Perms
}

function grant(perms: Perms, actions: readonly Action[]): void {
  for (const a of actions) perms[a] = true
}

interface ScopeRefs {
  userIds: string[]
  deptIds: string[]
}

function parseScopeRefs(raw: unknown): ScopeRefs {
  if (raw === null || raw === undefined) return { userIds: [], deptIds: [] }
  if (typeof raw === 'string') {
    try {
      return parseScopeRefs(JSON.parse(raw))
    } catch {
      return { userIds: [], deptIds: [] }
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { userIds: [], deptIds: [] }
  }
  const obj = raw as Record<string, unknown>
  const userIds = Array.isArray(obj.userIds)
    ? obj.userIds.filter((v): v is string => typeof v === 'string')
    : []
  const deptIds = Array.isArray(obj.deptIds)
    ? obj.deptIds.filter((v): v is string => typeof v === 'string')
    : []
  return { userIds, deptIds }
}

/** ACL perms JSON → 命中集合（非法 JSON / 非对象一律视为无追加） */
function parseAclPerms(raw: unknown): Partial<Record<Action, boolean>> {
  if (raw === null || raw === undefined) return {}
  let obj = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {}
  const out: Partial<Record<Action, boolean>> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if ((ACTIONS as readonly string[]).includes(k) && v === true) {
      out[k as Action] = true
    }
  }
  return out
}

/** 资源解析结果：统一拿到 projectId + 各类型基线判定所需字段 */
interface ResolvedResource {
  projectId: string
  /** FILE_REQ 专属：范围终审数据 */
  requirement?: {
    ownerId: string | null
    scope: FileScope
    scopeRefs: unknown
    phaseCode: string | null
  }
  /** TASK 专属 */
  task?: { phaseId: string | null; assigneeId: string | null }
  phase?: { ownerId: string | null }
  /** FILE_FOLDER 专属（网盘化 20260830）：物化路径供祖先链 ACL 并集 */
  folder?: { path: string }
}

async function resolveResource(res: Res): Promise<ResolvedResource | null> {
  switch (res.type) {
    case 'PROJECT': {
      const project = await prisma.project.findUnique({
        where: { id: res.id },
        select: { id: true },
      })
      return project ? { projectId: project.id } : null
    }
    case 'PHASE': {
      const phase = await prisma.phase.findUnique({
        where: { id: res.id },
        select: { projectId: true, ownerId: true },
      })
      if (!phase) return null
      return { projectId: phase.projectId, phase: { ownerId: phase.ownerId } }
    }
    case 'TASK': {
      const task = await prisma.task.findUnique({
        where: { id: res.id },
        select: { projectId: true, phaseId: true, assigneeId: true },
      })
      if (!task) return null
      return {
        projectId: task.projectId,
        task: { phaseId: task.phaseId, assigneeId: task.assigneeId },
      }
    }
    case 'FILE_FOLDER': {
      const catalog = await prisma.fileCatalog.findUnique({
        where: { id: res.id },
        select: { projectId: true, path: true },
      })
      if (!catalog) return null
      return { projectId: catalog.projectId, folder: { path: catalog.path } }
    }
    case 'FILE_REQ': {
      const req = await prisma.fileRequirement.findUnique({
        where: { id: res.id },
        select: {
          projectId: true,
          ownerId: true,
          scope: true,
          scopeRefs: true,
          phaseCode: true,
        },
      })
      if (!req) return null
      return {
        projectId: req.projectId,
        requirement: {
          ownerId: req.ownerId,
          scope: req.scope,
          scopeRefs: req.scopeRefs,
          phaseCode: req.phaseCode,
        },
      }
    }
    default:
      return null
  }
}

/** 文件条目范围终审（§6.1 第 4 步）：返回该用户对条目的 view/download 裁决 */
function scopeFinalize(
  requirement: NonNullable<ResolvedResource['requirement']>,
  userId: string,
  departmentId: string | null,
  memberRole: string | null,
): boolean {
  switch (requirement.scope) {
    case 'PUBLIC':
      // 项目成员 view/download
      return memberRole !== null
    case 'RESTRICTED': {
      const refs = parseScopeRefs(requirement.scopeRefs)
      return (
        refs.userIds.includes(userId) ||
        (departmentId !== null && refs.deptIds.includes(departmentId))
      )
    }
    case 'PRIVATE':
      // ownerId + 项目 OWNER（封闭名单，否决其余来源）
      return requirement.ownerId === userId || memberRole === 'OWNER'
    default:
      return false
  }
}

interface PermissionContext {
  user: { id: string; role: string; isActive: boolean; departmentId: string | null }
  memberRole: string | null
}

/** ACL 主体匹配：USER=本人；DEPARTMENT=本部门；ROLE=项目角色名或全局角色名 */
function principalMatch(
  principalType: string,
  principalId: string,
  ctx: PermissionContext,
): boolean {
  switch (principalType) {
    case 'USER':
      return principalId === ctx.user.id
    case 'DEPARTMENT':
      return ctx.user.departmentId !== null && principalId === ctx.user.departmentId
    case 'ROLE':
      return (
        (ctx.memberRole !== null && principalId === ctx.memberRole) ||
        principalId === ctx.user.role
      )
    default:
      return false
  }
}

/** 核心合成：算出某用户对某资源的完整权限集合（8 键） */
async function computePerms(
  userId: string,
  res: Res,
): Promise<{ perms: Perms; projectId: string | null }> {
  // 0) 未登录 / 空 id：一律拒绝
  if (!userId) return { perms: blankPerms(), projectId: null }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true, departmentId: true },
  })
  if (!user || !user.isActive) return { perms: blankPerms(), projectId: null }

  // 2) 解析资源所属项目（资源不存在 → 拒绝；ADMIN 也不授权幽灵资源）
  const resolved = await resolveResource(res)
  if (!resolved) return { perms: blankPerms(), projectId: null }

  const project = await prisma.project.findUnique({
    where: { id: resolved.projectId },
    select: { isArchived: true },
  })
  if (!project) return { perms: blankPerms(), projectId: resolved.projectId }

  // 1) 全局 ADMIN → 直通（含归档项目与 PRIVATE 文件）
  if (user.role === 'ADMIN') return { perms: fullPerms(), projectId: resolved.projectId }

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: resolved.projectId, userId } },
    select: { role: true },
  })
  const ctx: PermissionContext = {
    user: {
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      departmentId: user.departmentId,
    },
    memberRole: member ? member.role : null,
  }

  const perms = blankPerms()
  // 定向审阅人标记：阶段负责人命中该条目 或 ACL 显式授 approve（用于终审豁免）
  let designatedReviewer = false

  // ── 步骤 2：项目角色基线 ──
  if (member) {
    grant(perms, VIEW_ONLY) // MEMBER/VIEWER → view（所有项目成员底线）
    if (member.role === 'MANAGER') grant(perms, ['edit', 'assign'])
    if (member.role === 'OWNER') grant(perms, ACTIONS) // 项目内全允许
    // ── 网盘化（20260830-drive-war）：FILE_FOLDER 基线扩展 ──
    // 目录是容器不是交付物：MEMBER/MANAGER 需能建目录/传文件/改名/移动/下载（intent C1 用户目录自由），
    // delete（整树入回收站）留给 MANAGER/OWNER；VIEWER 仍只读。（MANAGER 项目基线本无 upload，此处补齐）
    if (res.type === 'FILE_FOLDER' && (member.role === 'MEMBER' || member.role === 'MANAGER')) {
      grant(perms, ['upload', 'edit', 'download'])
    }
  }

  // 阶段负责人 / 任务负责人（与成员身份可叠加）
  if (resolved.task) {
    const task = resolved.task
    if (task.assigneeId === userId) grant(perms, ['view', 'edit'])
    if (task.phaseId) {
      const phase = await prisma.phase.findUnique({
        where: { id: task.phaseId },
        select: { ownerId: true },
      })
      if (phase && phase.ownerId === userId) grant(perms, ACTIONS) // task.*
    }
  }
  if (resolved.phase && resolved.phase.ownerId === userId) {
    grant(perms, VIEW_ONLY) // 阶段负责人对自己负责的 PHASE 有管理可见性
  }
  if (resolved.requirement && resolved.requirement.phaseCode) {
    const phase = await prisma.phase.findUnique({
      where: {
        projectId_code: {
          projectId: resolved.projectId,
          code: resolved.requirement.phaseCode,
        },
      },
      select: { ownerId: true },
    })
    if (phase && phase.ownerId === userId) {
      grant(perms, ['approve', 'view'])
      designatedReviewer = true
    }
  }

  // ── 步骤 2b：文件条目责任人（个人交付物，2026-08-21）──
  // 条目 ownerId = 本人 → 可上传 / 查看 / 下载自己的交付物（成员提交工作文件）
  if (resolved.requirement && resolved.requirement.ownerId === userId) {
    grant(perms, ['view', 'upload', 'download'])
  }

  // ── 步骤 3：资源 ACL 合并（∪ 追加授权；不设减权）──
  // 网盘化：FILE_FOLDER 沿祖先链并集（给部门/人授权父目录 → 全部子目录生效，spec §3.2）
  const aclResourceIds =
    res.type === 'FILE_FOLDER' && resolved.folder && resolved.folder.path
      ? resolved.folder.path.split('/').filter(Boolean)
      : [res.id]
  const acls = await prisma.resourcePermission.findMany({
    where: { resourceType: res.type, resourceId: { in: aclResourceIds } },
    select: { principalType: true, principalId: true, perms: true },
  })
  for (const acl of acls) {
    if (!principalMatch(acl.principalType, acl.principalId, ctx)) continue
    const granted = parseAclPerms(acl.perms)
    if (granted.approve === true) designatedReviewer = true
    for (const action of ACTIONS) {
      if (granted[action] === true) perms[action] = true
    }
  }

  // ── 归档终审：归档项目只读（非 ADMIN 仅保留 view/download）──
  if (project.isArchived) {
    for (const a of ACTIONS) {
      if (a !== 'view' && a !== 'download') perms[a] = false
    }
  }

  // ── 步骤 4：文件条目范围终审（view/download 裁决替换）──
  //   裁决集 = 范围名单 ∪ {定向审阅人}（能审必能看，但通配基线不豁免，见文件头注）
  if (resolved.requirement) {
    const scopeOk = scopeFinalize(
      resolved.requirement,
      userId,
      user.departmentId,
      ctx.memberRole,
    )
    perms.view = scopeOk || designatedReviewer
    perms.download = scopeOk || designatedReviewer
  }

  return { perms, projectId: resolved.projectId }
}

/** 取完整权限集合（走 LRU 缓存） */
async function getPerms(userId: string, res: Res): Promise<Perms> {
  const key = cacheKey(userId || '', res)
  const hit = cacheGet(key)
  if (hit) return hit.perms
  const { perms, projectId } = await computePerms(userId, res)
  cacheSet(key, {
    perms,
    projectId,
    expiresAt: Date.now() + cacheConfig.ttlMs,
  })
  return perms
}

// ───────────────────────────── 公开接口（§6.2）─────────────────────────────

/** 单点判定：user 能否对 res 执行 action */
export async function can(
  userId: string,
  action: Action,
  res: Res,
): Promise<boolean> {
  const perms = await getPerms(userId || '', res)
  return perms[action] === true
}

/** 断言式判定：不通过抛 ApiError(403) */
export async function requireCan(
  userId: string,
  action: Action,
  res: Res,
): Promise<void> {
  if (!(await can(userId, action, res))) {
    throw new ApiError(
      403,
      `无权执行 ${action}（资源 ${res.type}:${res.id}）`,
      'FORBIDDEN',
    )
  }
}

/** 权限摘要：前端按钮驱动（单资源响应体 permissions 字段） */
export async function permsOf(
  userId: string,
  res: Res,
): Promise<Perms> {
  return getPerms(userId || '', res)
}

/**
 * 可见文件条目过滤器（列表查询用，与 can() 的范围终审语义一致）：
 *   ADMIN → 无过滤（全量）
 *   PUBLIC     → 参与的项目（任意项目角色）
 *   RESTRICTED → scopeRefs.userIds 含本人 或 deptIds 含本人部门
 *   PRIVATE    → 本人负责（ownerId）或本人任 OWNER 的项目
 * 未登录 / 用户无效 → 永假条件（空集）
 *
 * 语义说明（与 can() 终审 `scopeOk || designatedReviewer` 完全对齐）：
 *   - RESTRICTED 定向授权不限项目成员：scopeRefs.userIds ∪ deptIds 命中即可，
 *     与 scopeFinalize 一致（文档 §6.1）；列表接口外层已强制 projectId 参数
 *     （无则 400），故此处无需再限定 projectId，定向授权给项目外人员是设计意图。
 *   - 本过滤器补 designatedReviewer 豁免（阶段负责人 + ACL 授 approve 者），
 *     避免「can() 单条可见但列表被过滤」的漏显 bug（能审必能看）。
 *   - 列表过滤只是候选集，真正的 view/download 终审在 can()/requireCan（下载、预览都走它）；
 *     列表略宽不构成越权，略窄才是漏显 bug，故 ROLE 匹配「所有项目 memberRole ∪ 全局角色」可接受。
 */
export async function visibleRequirementFilter(
  userId: string,
): Promise<Prisma.FileRequirementWhereInput> {
  const never: Prisma.FileRequirementWhereInput = { id: { in: [] } }
  if (!userId) return never

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true, departmentId: true },
  })
  if (!user || !user.isActive) return never
  if (user.role === 'ADMIN') return {}

  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true, role: true },
  })
  const memberProjectIds = memberships.map((m) => m.projectId)
  const ownerProjectIds = memberships
    .filter((m) => m.role === 'OWNER')
    .map((m) => m.projectId)

  const or: Prisma.FileRequirementWhereInput[] = []

  // PUBLIC：项目成员
  if (memberProjectIds.length > 0) {
    or.push({ scope: 'PUBLIC', projectId: { in: memberProjectIds } })
  }

  // RESTRICTED：scopeRefs 命中（本人 或 本人部门）
  const restrictedOr: Prisma.FileRequirementWhereInput[] = [
    { scopeRefs: { path: ['userIds'], array_contains: userId } },
  ]
  if (user.departmentId) {
    restrictedOr.push({
      scopeRefs: { path: ['deptIds'], array_contains: user.departmentId },
    })
  }
  or.push({ scope: 'RESTRICTED', OR: restrictedOr })

  // PRIVATE：责任人本人 或 本人任 OWNER 的项目
  const privateOr: Prisma.FileRequirementWhereInput[] = [{ ownerId: userId }]
  if (ownerProjectIds.length > 0) {
    privateOr.push({ scope: 'PRIVATE', projectId: { in: ownerProjectIds } })
  }
  or.push({ scope: 'PRIVATE', OR: privateOr })

  // ── designatedReviewer 豁免（与 can() 终审 `scopeOk || designatedReviewer` 对齐）──
  // (a) 阶段负责人豁免：本人负责的阶段下的条目（phaseCode 匹配 + 同项目）
  const ownedPhases = await prisma.phase.findMany({
    where: { ownerId: userId },
    select: { projectId: true, code: true },
  })
  const ownedPairs = ownedPhases.filter((p) => p.code)
  if (ownedPairs.length > 0) {
    or.push({ OR: ownedPairs.map((p) => ({ projectId: p.projectId, phaseCode: p.code })) })
  }

  // (b) ACL 授 approve 豁免：经 resourcePermission 被授 approve 的 FILE_REQ 条目
  //     （复用上方 memberships 的 role；ROLE 匹配收集「所有项目 memberRole ∪ 全局角色」，略宽但安全）
  const roleIds = Array.from(
    new Set([user.role, ...memberships.map((m) => m.role)]),
  )
  const aclOr: Prisma.ResourcePermissionWhereInput[] = [
    { principalType: 'USER', principalId: userId },
  ]
  if (user.departmentId) {
    aclOr.push({ principalType: 'DEPARTMENT', principalId: user.departmentId })
  }
  if (roleIds.length) {
    aclOr.push({ principalType: 'ROLE', principalId: { in: roleIds } })
  }
  const aclReqs = await prisma.resourcePermission.findMany({
    where: {
      resourceType: 'FILE_REQ',
      perms: { path: ['approve'], equals: true },
      OR: aclOr,
    },
    select: { resourceId: true },
  })
  if (aclReqs.length > 0) {
    or.push({ id: { in: aclReqs.map((r) => r.resourceId) } })
  }

  return { OR: or }
}

// ───────────────────────────── 批量权限判定（2026-08-22 P1-4 修复）─────────────────────────────

export interface BatchPermItem {
  type: 'TASK' | 'FILE_REQ'
  id: string
  projectId: string
  phaseId?: string | null
  assigneeId?: string | null
  ownerId?: string | null
  scope?: string | null
  scopeRefs?: unknown
  phaseCode?: string | null
}

/**
 * 批量计算同批资源的权限（消除列表场景 N 次 permsOf 的 N+1 查询）
 *
 * 与 computePerms 语义完全一致（项目角色基线 → 负责人加成 → ACL 合并 → 归档只读 → 范围终审），
 * 区别：一次批量预取 user/projects/members/phases/ACL，内存合成。
 * 调用方需传入已加载的资源对象（阶段详情页 tasks/requirements 已有全部字段），
 * 无需再触发 resolveResource 的单条查询。
 */
export async function batchPermsOf(
  userId: string,
  items: BatchPermItem[],
): Promise<Map<string, Perms>> {
  const result = new Map<string, Perms>()
  if (!userId || items.length === 0) return result

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true, departmentId: true },
  })
  if (!user || !user.isActive) {
    for (const it of items) result.set(it.id, blankPerms())
    return result
  }

  const projectIds = Array.from(new Set(items.map((i) => i.projectId)))
  const taskPhaseIds = Array.from(
    new Set(items.filter((i) => i.type === 'TASK' && i.phaseId).map((i) => i.phaseId as string)),
  )
  const reqPhaseKeys = Array.from(
    new Set(
      items
        .filter((i) => i.type === 'FILE_REQ' && i.phaseCode && i.projectId)
        .map((i) => `${i.projectId}:${i.phaseCode}`),
    ),
  )

  // 批量预取
  const [projects, members, taskPhases, reqPhases, acls] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, isArchived: true },
    }),
    prisma.projectMember.findMany({
      where: { projectId: { in: projectIds }, userId },
      select: { projectId: true, role: true },
    }),
    taskPhaseIds.length > 0
      ? prisma.phase.findMany({
          where: { id: { in: taskPhaseIds } },
          select: { id: true, ownerId: true },
        })
      : Promise.resolve([]),
    reqPhaseKeys.length > 0
      ? prisma.phase.findMany({
          where: {
            OR: reqPhaseKeys.map((k) => {
              const [projectId, code] = k.split(':')
              return { projectId, code }
            }),
          },
          select: { projectId: true, code: true, ownerId: true },
        })
      : Promise.resolve([]),
    prisma.resourcePermission.findMany({
      where: {
        resourceType: { in: ['TASK', 'FILE_REQ'] },
        resourceId: { in: items.map((i) => i.id) },
      },
      select: { resourceType: true, resourceId: true, principalType: true, principalId: true, perms: true },
    }),
  ])

  const projectById = new Map(projects.map((p) => [p.id, p]))
  const memberByProject = new Map(members.map((m) => [m.projectId, m.role]))
  const phaseOwnerByTask = new Map(taskPhases.map((p) => [p.id, p.ownerId]))
  const phaseOwnerByReqKey = new Map(reqPhases.map((p) => [`${p.projectId}:${p.code}`, p.ownerId]))
  const aclByRes = new Map<string, typeof acls>()
  for (const a of acls) {
    const arr = aclByRes.get(a.resourceId) ?? []
    arr.push(a)
    aclByRes.set(a.resourceId, arr)
  }

  for (const it of items) {
    const perms = blankPerms()
    const project = projectById.get(it.projectId)
    // 项目不存在 → 拒绝（与 resolveResource 幽灵资源一致）
    if (!project) {
      result.set(it.id, perms)
      continue
    }

    // 全局 ADMIN 直通（含归档与 PRIVATE）
    if (user.role === 'ADMIN') {
      result.set(it.id, fullPerms())
      continue
    }

    const memberRole = memberByProject.get(it.projectId) ?? null
    const ctx: PermissionContext = {
      user: { id: user.id, role: user.role, isActive: user.isActive, departmentId: user.departmentId },
      memberRole,
    }
    let designatedReviewer = false

    // 项目角色基线
    if (memberRole) {
      grant(perms, VIEW_ONLY)
      if (memberRole === 'MANAGER') grant(perms, ['edit', 'assign'])
      if (memberRole === 'OWNER') grant(perms, ACTIONS)
    }

    // 任务负责人 / 阶段负责人
    if (it.type === 'TASK') {
      if (it.assigneeId === userId) grant(perms, ['view', 'edit'])
      if (it.phaseId) {
        const phOwner = phaseOwnerByTask.get(it.phaseId)
        if (phOwner === userId) grant(perms, ACTIONS)
      }
    }

    // 文件条目：责任人加成 + 阶段负责人 approve
    if (it.type === 'FILE_REQ') {
      if (it.ownerId === userId) grant(perms, ['view', 'upload', 'download'])
      if (it.phaseCode) {
        const phOwner = phaseOwnerByReqKey.get(`${it.projectId}:${it.phaseCode}`)
        if (phOwner === userId) {
          grant(perms, ['approve', 'view'])
          designatedReviewer = true
        }
      }
    }

    // ACL 合并
    for (const acl of aclByRes.get(it.id) ?? []) {
      if (!principalMatch(acl.principalType, acl.principalId, ctx)) continue
      const granted = parseAclPerms(acl.perms)
      if (granted.approve === true) designatedReviewer = true
      for (const action of ACTIONS) {
        if (granted[action] === true) perms[action] = true
      }
    }

    // 归档只读
    if (project.isArchived) {
      for (const a of ACTIONS) {
        if (a !== 'view' && a !== 'download') perms[a] = false
      }
    }

    // 文件条目范围终审
    if (it.type === 'FILE_REQ') {
      const scopeOk = scopeFinalize(
        { ownerId: it.ownerId ?? null, scope: it.scope as FileScope, scopeRefs: it.scopeRefs, phaseCode: it.phaseCode ?? null },
        userId,
        user.departmentId,
        memberRole,
      )
      perms.view = scopeOk || designatedReviewer
      perms.download = scopeOk || designatedReviewer
    }

    result.set(it.id, perms)
  }

  return result
}
