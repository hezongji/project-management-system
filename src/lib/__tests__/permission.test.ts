/**
 * 权限引擎单测（P0-2）
 * 覆盖：三层合成矩阵（全局角色 × 项目角色 × ACL）、文件范围终审、
 *       边界（未登录/跨项目/已归档/RESTRICTED 越权）、LRU 缓存、visibleRequirementFilter。
 * 方式：jest.mock('../prisma') 注入内存库（不连真实 PG，纯逻辑单测）。
 */

jest.mock('../prisma', () => ({ prisma: {} }))

import { prisma } from '../prisma'
import {
  can,
  requireCan,
  permsOf,
  visibleRequirementFilter,
  invalidatePerms,
  invalidateProject,
  configurePermissionCache,
  ACTIONS,
  ApiError,
} from '../permission'

// ───────────────────────── 内存库 fixture ─────────────────────────

interface U {
  id: string
  role: string
  isActive: boolean
  departmentId: string | null
}
interface P { id: string; isArchived: boolean }
interface M { projectId: string; userId: string; role: string }
interface Ph { id: string; projectId: string; code: string; ownerId: string | null }
interface T { id: string; projectId: string; phaseId: string | null; assigneeId: string | null }
interface C { id: string; projectId: string }
interface R {
  id: string
  projectId: string
  ownerId: string | null
  scope: string
  scopeRefs: unknown
  phaseCode: string | null
}
interface Acl {
  resourceType: string
  resourceId: string
  principalType: string
  principalId: string
  perms: unknown
}

interface DB {
  users: U[]
  projects: P[]
  members: M[]
  phases: Ph[]
  tasks: T[]
  catalogs: C[]
  requirements: R[]
  acl: Acl[]
}

function baseDb(): DB {
  return {
    users: [
      { id: 'u-admin', role: 'ADMIN', isActive: true, departmentId: null },
      { id: 'u-gpm', role: 'PROJECT_MANAGER', isActive: true, departmentId: null },
      { id: 'u-out', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-owner', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-mgr', role: 'MEMBER', isActive: true, departmentId: 'dept-elec' },
      { id: 'u-mem', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-viewer', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-phase', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-assignee', role: 'MEMBER', isActive: true, departmentId: null },
      { id: 'u-disabled', role: 'MEMBER', isActive: false, departmentId: null },
    ],
    projects: [
      { id: 'p1', isArchived: false },
      { id: 'p2', isArchived: false },
      { id: 'pa', isArchived: true },
    ],
    members: [
      { projectId: 'p1', userId: 'u-owner', role: 'OWNER' },
      { projectId: 'p1', userId: 'u-mgr', role: 'MANAGER' },
      { projectId: 'p1', userId: 'u-mem', role: 'MEMBER' },
      { projectId: 'p1', userId: 'u-viewer', role: 'VIEWER' },
      { projectId: 'pa', userId: 'u-owner', role: 'OWNER' },
    ],
    phases: [
      { id: 'ph1', projectId: 'p1', code: 'PH01', ownerId: 'u-phase' },
      { id: 'ph2', projectId: 'p1', code: 'PH02', ownerId: 'u-admin' },
    ],
    tasks: [
      { id: 't1', projectId: 'p1', phaseId: 'ph1', assigneeId: 'u-assignee' },
      { id: 't2', projectId: 'p1', phaseId: 'ph2', assigneeId: null },
      { id: 't3', projectId: 'p2', phaseId: null, assigneeId: null },
      { id: 'ta', projectId: 'pa', phaseId: null, assigneeId: 'u-owner' },
    ],
    catalogs: [{ id: 'c1', projectId: 'p1' }],
    requirements: [
      { id: 'r-pub', projectId: 'p1', ownerId: 'u-mem', scope: 'PUBLIC', scopeRefs: null, phaseCode: 'PH01' },
      { id: 'r-rst', projectId: 'p1', ownerId: 'u-mem', scope: 'RESTRICTED', scopeRefs: { userIds: ['u-out'], deptIds: ['dept-elec'] }, phaseCode: 'PH01' },
      { id: 'r-pri', projectId: 'p1', ownerId: 'u-mem', scope: 'PRIVATE', scopeRefs: null, phaseCode: 'PH02' },
      { id: 'r-bad', projectId: 'p1', ownerId: 'u-mem', scope: 'RESTRICTED', scopeRefs: '{"userIds":[', phaseCode: null },
    ],
    acl: [
      // u-mem 对 t2 追加 edit
      { resourceType: 'TASK', resourceId: 't2', principalType: 'USER', principalId: 'u-mem', perms: { edit: true } },
      // u-out（非项目成员）对 t2 追加 delete
      { resourceType: 'TASK', resourceId: 't2', principalType: 'USER', principalId: 'u-out', perms: { delete: true } },
      // 电气部门对 t2 追加 upload
      { resourceType: 'TASK', resourceId: 't2', principalType: 'DEPARTMENT', principalId: 'dept-elec', perms: { upload: true } },
      // 项目角色 VIEWER 对 t2 追加 edit
      { resourceType: 'TASK', resourceId: 't2', principalType: 'ROLE', principalId: 'VIEWER', perms: { edit: true } },
      // 全局角色 PROJECT_MANAGER 对 t2 追加 archive
      { resourceType: 'TASK', resourceId: 't2', principalType: 'ROLE', principalId: 'PROJECT_MANAGER', perms: { archive: true } },
      // PROJECT 层 ACL 给 u-out view（用于类型隔离测试）
      { resourceType: 'PROJECT', resourceId: 'p1', principalType: 'USER', principalId: 'u-out', perms: { view: true } },
      // 坏 JSON perms：应被忽略
      { resourceType: 'TASK', resourceId: 't1', principalType: 'USER', principalId: 'u-mem', perms: '{"edit":[' },
      // ACL 显式 false 不减权（OWNER view 仍应保留）
      { resourceType: 'PROJECT', resourceId: 'p1', principalType: 'USER', principalId: 'u-owner', perms: { view: false } },
    ],
  }
}

/** 把内存库装进 mock prisma；返回查询计数器（缓存测试用） */
function install(db: DB): { queries: number } {
  const calls = { queries: 0 }
  const bump = () => {
    calls.queries++
    return undefined
  }
  const mock = {
    user: {
      findUnique: (args: { where: { id: string } }) => {
        bump()
        return db.users.find((u) => u.id === args.where.id) ?? null
      },
    },
    project: {
      findUnique: (args: { where: { id: string } }) => {
        bump()
        return db.projects.find((p) => p.id === args.where.id) ?? null
      },
    },
    phase: {
      findUnique: (args: { where: { id?: string; projectId_code?: { projectId: string; code: string } } }) => {
        bump()
        const w = args.where
        if (w.id !== undefined) return db.phases.find((p) => p.id === w.id) ?? null
        const pc = w.projectId_code!
        return db.phases.find((p) => p.projectId === pc.projectId && p.code === pc.code) ?? null
      },
      findMany: (args: { where: { ownerId: string } }) => {
        bump()
        return db.phases.filter((p) => p.ownerId === args.where.ownerId)
      },
    },
    task: {
      findUnique: (args: { where: { id: string } }) => {
        bump()
        return db.tasks.find((t) => t.id === args.where.id) ?? null
      },
    },
    fileCatalog: {
      findUnique: (args: { where: { id: string } }) => {
        bump()
        return db.catalogs.find((c) => c.id === args.where.id) ?? null
      },
    },
    fileRequirement: {
      findUnique: (args: { where: { id: string } }) => {
        bump()
        return db.requirements.find((r) => r.id === args.where.id) ?? null
      },
    },
    projectMember: {
      findUnique: (args: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
        bump()
        const w = args.where.projectId_userId
        return db.members.find((m) => m.projectId === w.projectId && m.userId === w.userId) ?? null
      },
      findMany: (args: { where: { userId: string } }) => {
        bump()
        return db.members.filter((m) => m.userId === args.where.userId)
      },
    },
    resourcePermission: {
      // 两种查询形态：computePerms 按资源精确定位；visibleRequirementFilter 按 approve 豁免查询
      findMany: (args: { where: Record<string, unknown> }) => {
        bump()
        const w = args.where
        if (w.resourceId !== undefined) {
          return db.acl.filter(
            (a) => a.resourceType === w.resourceType && a.resourceId === w.resourceId,
          )
        }
        const path = w.perms as { path: string[]; equals: boolean }
        const orCond =
          (w.OR as Array<{ principalType: string; principalId: string | { in: string[] } }>) ?? []
        return db.acl.filter((a) => {
          if (a.resourceType !== w.resourceType) return false
          const p =
            typeof a.perms === 'object' && a.perms !== null
              ? (a.perms as Record<string, unknown>)
              : {}
          if (p[path.path[0]] !== path.equals) return false
          return orCond.some((c) => {
            if (c.principalType === 'ROLE') {
              const ids = (c.principalId as { in: string[] }).in
              return Array.isArray(ids) && ids.includes(a.principalId)
            }
            return a.principalType === c.principalType && a.principalId === c.principalId
          })
        })
      },
    },
  }
  Object.assign(prisma as unknown as Record<string, unknown>, mock)
  return calls
}

let db: DB
let calls: { queries: number }

beforeEach(() => {
  db = baseDb()
  calls = install(db)
  invalidatePerms() // 清缓存，隔离用例
})

afterEach(() => {
  configurePermissionCache({ ttlMs: 5 * 60 * 1000, maxEntries: 5000 })
  jest.useRealTimers()
})

// ───────────────────────── 1. 第一层：全局角色 ─────────────────────────

describe('第一层：全局角色（GlobalRole）', () => {
  it('ADMIN 直通：对项目资源 8 个 Action 全 true', async () => {
    const perms = await permsOf('u-admin', { type: 'PROJECT', id: 'p1' })
    for (const a of ACTIONS) expect(perms[a]).toBe(true)
  })

  it('ADMIN 直通绕过 PRIVATE 文件范围终审（非 owner、非成员仍可 view）', async () => {
    expect(await can('u-admin', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
    expect(await can('u-admin', 'download', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
  })

  it('ADMIN 直通绕过归档只读限制', async () => {
    expect(await can('u-admin', 'edit', { type: 'PROJECT', id: 'pa' })).toBe(true)
    expect(await can('u-admin', 'archive', { type: 'TASK', id: 'ta' })).toBe(true)
  })

  it('全局 PROJECT_MANAGER 无项目角色时对项目资源无权限（§7.4 仅控制建项目）', async () => {
    expect(await can('u-gpm', 'view', { type: 'PROJECT', id: 'p1' })).toBe(false)
    expect(await can('u-gpm', 'edit', { type: 'TASK', id: 't2' })).toBe(false)
  })

  it('全局 PROJECT_MANAGER 可经 ACL 的 ROLE 主体获权', async () => {
    expect(await can('u-gpm', 'archive', { type: 'TASK', id: 't2' })).toBe(true)
  })

  it('全局 MEMBER 未加入项目且无 ACL：view false（改用无 ACL 的 p2，u-out 在 p1 有 PROJECT 层 ACL）', async () => {
    expect(await can('u-out', 'view', { type: 'PROJECT', id: 'p2' })).toBe(false)
  })

  it('未登录（userId 空）：一律 false', async () => {
    expect(await can('', 'view', { type: 'PROJECT', id: 'p1' })).toBe(false)
    expect(await can('', 'edit', { type: 'TASK', id: 't1' })).toBe(false)
  })

  it('用户不存在：false', async () => {
    expect(await can('u-ghost', 'view', { type: 'PROJECT', id: 'p1' })).toBe(false)
  })

  it('isActive=false：false', async () => {
    expect(await can('u-disabled', 'view', { type: 'PROJECT', id: 'p1' })).toBe(false)
  })
})

// ───────────────────────── 2. 第二层：项目角色基线 ─────────────────────────

describe('第二层：项目角色基线（ProjectRole）', () => {
  it('OWNER：项目内全允许（8 Action 全 true）', async () => {
    const perms = await permsOf('u-owner', { type: 'PROJECT', id: 'p1' })
    for (const a of ACTIONS) expect(perms[a]).toBe(true)
  })

  it('MANAGER：view/edit/assign true，其余 false', async () => {
    const perms = await permsOf('u-mgr', { type: 'PROJECT', id: 'p1' })
    expect(perms.view).toBe(true)
    expect(perms.edit).toBe(true)
    expect(perms.assign).toBe(true)
    expect(perms.delete).toBe(false)
    expect(perms.upload).toBe(false)
    expect(perms.download).toBe(false)
    expect(perms.approve).toBe(false)
    expect(perms.archive).toBe(false)
  })

  it('MEMBER：仅 view', async () => {
    const perms = await permsOf('u-mem', { type: 'PROJECT', id: 'p1' })
    expect(perms.view).toBe(true)
    for (const a of ACTIONS) {
      if (a !== 'view') expect(perms[a]).toBe(false)
    }
  })

  it('VIEWER：仅 view', async () => {
    const perms = await permsOf('u-viewer', { type: 'PROJECT', id: 'p1' })
    expect(perms.view).toBe(true)
    for (const a of ACTIONS) {
      if (a !== 'view') expect(perms[a]).toBe(false)
    }
  })

  it('基线作用于项目内任意资源类型：MANAGER 对 TASK edit true / MEMBER 对 TASK edit false / VIEWER 对 TASK view true', async () => {
    expect(await can('u-mgr', 'edit', { type: 'TASK', id: 't1' })).toBe(true)
    expect(await can('u-mem', 'edit', { type: 'TASK', id: 't1' })).toBe(false)
    expect(await can('u-viewer', 'view', { type: 'TASK', id: 't1' })).toBe(true)
  })

  it('FILE_FOLDER 目录：MEMBER 仅 view，无其他基线', async () => {
    expect(await can('u-mem', 'view', { type: 'FILE_FOLDER', id: 'c1' })).toBe(true)
    expect(await can('u-mem', 'upload', { type: 'FILE_FOLDER', id: 'c1' })).toBe(false)
  })
})

// ───────────────── 2b. 阶段负责人 / 任务负责人基线 ─────────────────

describe('第二层扩展：阶段负责人与任务负责人', () => {
  it('阶段负责人（非项目成员）对其阶段内 TASK 全权（task.*）', async () => {
    const perms = await permsOf('u-phase', { type: 'TASK', id: 't1' })
    for (const a of ACTIONS) expect(perms[a]).toBe(true)
  })

  it('阶段负责人对其他阶段的 TASK 无权限', async () => {
    expect(await can('u-phase', 'edit', { type: 'TASK', id: 't2' })).toBe(false)
  })

  it('阶段负责人对自己负责的 PHASE 有 view（管理可见性）', async () => {
    expect(await can('u-phase', 'view', { type: 'PHASE', id: 'ph1' })).toBe(true)
    expect(await can('u-phase', 'edit', { type: 'PHASE', id: 'ph1' })).toBe(false)
  })

  it('任务负责人（非项目成员）：该 task view+edit true，delete false', async () => {
    expect(await can('u-assignee', 'view', { type: 'TASK', id: 't1' })).toBe(true)
    expect(await can('u-assignee', 'edit', { type: 'TASK', id: 't1' })).toBe(true)
    expect(await can('u-assignee', 'delete', { type: 'TASK', id: 't1' })).toBe(false)
  })

  it('阶段负责人对关联阶段的 FILE_REQ 有 approve+view（file.approve）', async () => {
    expect(await can('u-phase', 'approve', { type: 'FILE_REQ', id: 'r-pub' })).toBe(true)
    expect(await can('u-phase', 'view', { type: 'FILE_REQ', id: 'r-pub' })).toBe(true)
  })

  it('普通 MEMBER 对 FILE_REQ 无 approve', async () => {
    expect(await can('u-mem', 'approve', { type: 'FILE_REQ', id: 'r-pub' })).toBe(false)
  })
})

// ───────────────────────── 3. 第三层：资源 ACL ─────────────────────────

describe('第三层：资源 ACL（∪ 追加授权）', () => {
  it('ACL USER 主体追加：MEMBER 经 ACL 获得 TASK edit', async () => {
    expect(await can('u-mem', 'edit', { type: 'TASK', id: 't2' })).toBe(true)
  })

  it('ACL 未命中的 USER 不获权：u-gpm 无 t2 delete', async () => {
    expect(await can('u-gpm', 'delete', { type: 'TASK', id: 't2' })).toBe(false)
  })

  it('ACL 可授权项目外用户：u-out（非成员）经 ACL 获得 t2 delete', async () => {
    expect(await can('u-out', 'delete', { type: 'TASK', id: 't2' })).toBe(true)
  })

  it('ACL DEPARTMENT 主体：同部门用户获 upload', async () => {
    expect(await can('u-mgr', 'upload', { type: 'TASK', id: 't2' })).toBe(true)
    expect(await can('u-mem', 'upload', { type: 'TASK', id: 't2' })).toBe(false)
  })

  it('ACL ROLE 主体按项目角色匹配：VIEWER 成员获 edit', async () => {
    expect(await can('u-viewer', 'edit', { type: 'TASK', id: 't2' })).toBe(true)
  })

  it('ACL ROLE 主体按全局角色匹配：PROJECT_MANAGER 获 archive', async () => {
    expect(await can('u-gpm', 'archive', { type: 'TASK', id: 't2' })).toBe(true)
  })

  it('ACL 不减权：perms 中显式 false 不剥夺 OWNER 基线 view', async () => {
    expect(await can('u-owner', 'view', { type: 'PROJECT', id: 'p1' })).toBe(true)
  })

  it('ACL 资源类型隔离：PROJECT 层 ACL 不作用于 TASK', async () => {
    expect(await can('u-out', 'view', { type: 'PROJECT', id: 'p1' })).toBe(true)
    expect(await can('u-out', 'view', { type: 'TASK', id: 't2' })).toBe(false)
  })

  it('ACL perms 为坏 JSON：忽略，不追加也不报错', async () => {
    expect(await can('u-mem', 'edit', { type: 'TASK', id: 't1' })).toBe(false)
  })
})

// ───────────────── 4. 第四层：文件条目范围终审（FILE_REQ）─────────────────

describe('第四层：文件条目范围终审（OPEN_SCOPE）', () => {
  it('PUBLIC：项目成员 view+download true', async () => {
    expect(await can('u-mem', 'view', { type: 'FILE_REQ', id: 'r-pub' })).toBe(true)
    expect(await can('u-mem', 'download', { type: 'FILE_REQ', id: 'r-pub' })).toBe(true)
  })

  it('PUBLIC：非项目成员 false（终审否决）', async () => {
    expect(await can('u-gpm', 'view', { type: 'FILE_REQ', id: 'r-pub' })).toBe(false)
    expect(await can('u-out', 'download', { type: 'FILE_REQ', id: 'r-pub' })).toBe(false)
  })

  it('RESTRICTED：scopeRefs.userIds 命中（即使非项目成员）→ true', async () => {
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(true)
    expect(await can('u-out', 'download', { type: 'FILE_REQ', id: 'r-rst' })).toBe(true)
  })

  it('RESTRICTED：scopeRefs.deptIds 命中用户部门 → true', async () => {
    expect(await can('u-mgr', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(true)
  })

  it('RESTRICTED 越权：范围外用户（含项目 MEMBER）→ false', async () => {
    expect(await can('u-mem', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(false)
  })

  it('RESTRICTED 越权：项目 OWNER 不在范围名单内也被否决（PRIVATE 才有 OWNER 豁免）', async () => {
    expect(await can('u-owner', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(false)
  })

  it('RESTRICTED：scopeRefs 非法 JSON 按「无命中」处理 → false', async () => {
    expect(await can('u-mem', 'view', { type: 'FILE_REQ', id: 'r-bad' })).toBe(false)
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-bad' })).toBe(false)
  })

  it('PRIVATE：责任人本人（ownerId）→ true', async () => {
    expect(await can('u-mem', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
    expect(await can('u-mem', 'download', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
  })

  it('PRIVATE：项目 OWNER → true（豁免名单）', async () => {
    expect(await can('u-owner', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
  })

  it('PRIVATE：MANAGER 越权 → false', async () => {
    expect(await can('u-mgr', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(false)
  })

  it('定向审阅人豁免：ACL 显式授 approve 的非成员对 PRIVATE 条目可见（能审必能看）', async () => {
    db.acl.push({
      resourceType: 'FILE_REQ',
      resourceId: 'r-pri',
      principalType: 'USER',
      principalId: 'u-out',
      perms: { approve: true },
    })
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
    expect(await can('u-out', 'download', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
    expect(await can('u-out', 'edit', { type: 'FILE_REQ', id: 'r-pri' })).toBe(false) // 终审外仍无权
  })

  it('定向审阅人不殃及他人阶段：PH01 负责人对 PH02 的 PRIVATE 条目仍被否决', async () => {
    expect(await can('u-phase', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(false)
  })

  it('RESTRICTED：scopeRefs 为字符串化 JSON 且命中 → true；数组/非法类型不命中', async () => {
    db.requirements.push({
      id: 'r-rst-str',
      projectId: 'p1',
      ownerId: 'u-mem',
      scope: 'RESTRICTED',
      scopeRefs: JSON.stringify({ userIds: ['u-out'], deptIds: [] }),
      phaseCode: null,
    })
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-rst-str' })).toBe(true)
    db.requirements.push({
      id: 'r-rst-arr',
      projectId: 'p1',
      ownerId: 'u-mem',
      scope: 'RESTRICTED',
      scopeRefs: ['u-out'],
      phaseCode: null,
    })
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-rst-arr' })).toBe(false)
  })

  it('终审只裁决 view/download：非只读 Action 仍走基线+ACL（MANAGER 对 FILE_REQ edit true）', async () => {
    expect(await can('u-mgr', 'edit', { type: 'FILE_REQ', id: 'r-pub' })).toBe(true)
    expect(await can('u-mem', 'edit', { type: 'FILE_REQ', id: 'r-pub' })).toBe(false)
  })
})

// ───────────────────────── 5. 边界场景 ─────────────────────────

describe('边界场景', () => {
  it('已归档项目：OWNER 变只读（edit/archive false，view true）', async () => {
    expect(await can('u-owner', 'view', { type: 'TASK', id: 'ta' })).toBe(true)
    expect(await can('u-owner', 'edit', { type: 'TASK', id: 'ta' })).toBe(false)
    expect(await can('u-owner', 'archive', { type: 'PROJECT', id: 'pa' })).toBe(false)
  })

  it('已归档项目：ADMIN 不受限', async () => {
    expect(await can('u-admin', 'edit', { type: 'TASK', id: 'ta' })).toBe(true)
  })

  it('跨项目：P1 的 OWNER 对 P2 资源无权限（无成员关系/无 ACL）', async () => {
    expect(await can('u-owner', 'view', { type: 'PROJECT', id: 'p2' })).toBe(false)
    expect(await can('u-owner', 'edit', { type: 'TASK', id: 't3' })).toBe(false)
  })

  it('跨项目 ACL：资源 ACL 指名授权可跨项目生效', async () => {
    db.acl.push({
      resourceType: 'TASK',
      resourceId: 't3',
      principalType: 'USER',
      principalId: 'u-owner',
      perms: { upload: true },
    })
    expect(await can('u-owner', 'upload', { type: 'TASK', id: 't3' })).toBe(true)
    expect(await can('u-owner', 'edit', { type: 'TASK', id: 't3' })).toBe(false)
  })

  it('资源不存在：false', async () => {
    expect(await can('u-owner', 'view', { type: 'TASK', id: 't-none' })).toBe(false)
    expect(await can('u-admin', 'view', { type: 'PHASE', id: 'ph-none' })).toBe(false)
  })

  it('未知资源类型 / 未知 scope：拒绝（default 分支）', async () => {
    expect(await can('u-owner', 'view', { type: 'FILE_FOLDER', id: 'nope' })).toBe(false)
    db.requirements.push({
      id: 'r-weird',
      projectId: 'p1',
      ownerId: null,
      scope: 'PUBLIC',
      scopeRefs: null,
      phaseCode: null,
    })
    ;(db.requirements[db.requirements.length - 1] as unknown as { scope: string }).scope =
      'WEIRD_SCOPE'
    expect(
      await can('u-mem', 'view', {
        type: 'FILE_REQ',
        id: 'r-weird',
      }),
    ).toBe(false)
  })

  it('requireCan：有权限时不抛', async () => {
    await expect(
      requireCan('u-owner', 'edit', { type: 'PROJECT', id: 'p1' }),
    ).resolves.toBeUndefined()
  })

  it('requireCan：无权限时抛 ApiError(403)', async () => {
    await expect(
      requireCan('u-out', 'edit', { type: 'PROJECT', id: 'p1' }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(requireCan('u-out', 'edit', { type: 'PROJECT', id: 'p1' })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('requireCan：错误信息包含 action 与资源定位', async () => {
    const err = await requireCan('u-out', 'edit', { type: 'PROJECT', id: 'p1' }).catch(
      (e: unknown) => e as ApiError,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toContain('edit')
    expect((err as ApiError).message).toContain('PROJECT:p1')
  })
})

// ───────────────────────── 6. LRU 缓存 ─────────────────────────

describe('LRU 缓存（TTL 5min / user/project 失效）', () => {
  it('命中缓存：重复判定不再查库', async () => {
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    const q1 = calls.queries
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    await can('u-mem', 'edit', { type: 'TASK', id: 't2' }) // permsOf 集合同一缓存条目
    await permsOf('u-mem', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBe(q1)
    expect(q1).toBeGreaterThan(0)
  })

  it('不同用户/不同资源不共享缓存', async () => {
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    const q1 = calls.queries
    await can('u-viewer', 'view', { type: 'TASK', id: 't2' })
    await can('u-mem', 'view', { type: 'PROJECT', id: 'p1' })
    expect(calls.queries).toBeGreaterThan(q1)
  })

  it('invalidatePerms(userId)：用户级失效后重查', async () => {
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    await can('u-viewer', 'view', { type: 'TASK', id: 't2' })
    const q1 = calls.queries
    invalidatePerms('u-mem')
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBeGreaterThan(q1)
    // 另一用户缓存不受影响
    const q2 = calls.queries
    await can('u-viewer', 'view', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBe(q2)
  })

  it('invalidateProject(projectId)：项目级失效（模拟成员变更）', async () => {
    await can('u-mem', 'view', { type: 'TASK', id: 't2' }) // p1
    await can('u-owner', 'view', { type: 'TASK', id: 't3' }) // p2（无成员关系）
    const q1 = calls.queries
    invalidateProject('p1')
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBeGreaterThan(q1)
  })

  it('TTL 5 分钟过期后重查', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000_000)
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    const q1 = calls.queries
    jest.setSystemTime(1_000_000 + 5 * 60 * 1000 + 1) // TTL+1ms
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBeGreaterThan(q1)
  })

  it('TTL 内不过期：时间推进 4 分 59 秒仍命中', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000_000)
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    const q1 = calls.queries
    jest.setSystemTime(1_000_000 + 5 * 60 * 1000 - 1000)
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    expect(calls.queries).toBe(q1)
  })

  it('LRU 容量淘汰：容量 1 时新资源顶掉旧条目', async () => {
    configurePermissionCache({ maxEntries: 1 })
    await can('u-mem', 'view', { type: 'TASK', id: 't2' })
    await can('u-owner', 'view', { type: 'PROJECT', id: 'p1' }) // 淘汰 u-mem:t2
    const q1 = calls.queries
    await can('u-owner', 'view', { type: 'PROJECT', id: 'p1' }) // 仍命中
    expect(calls.queries).toBe(q1)
    await can('u-mem', 'view', { type: 'TASK', id: 't2' }) // 已被淘汰 → 重查
    expect(calls.queries).toBeGreaterThan(q1)
  })

  it('数据变更后 invalidatePerms 使缓存结论即时更新（模拟 ACL 变更）', async () => {
    expect(await can('u-mem', 'delete', { type: 'TASK', id: 't2' })).toBe(false)
    db.acl.push({
      resourceType: 'TASK',
      resourceId: 't2',
      principalType: 'USER',
      principalId: 'u-mem',
      perms: { delete: true },
    })
    expect(await can('u-mem', 'delete', { type: 'TASK', id: 't2' })).toBe(false) // 缓存内旧结论
    invalidatePerms('u-mem')
    expect(await can('u-mem', 'delete', { type: 'TASK', id: 't2' })).toBe(true)
  })
})

// ───────────────── 7. visibleRequirementFilter（列表过滤）─────────────────

describe('visibleRequirementFilter（列表过滤，与终审语义一致）', () => {
  it('ADMIN → 无过滤（全量可见）', async () => {
    await expect(visibleRequirementFilter('u-admin')).resolves.toEqual({})
  })

  it('未登录 / 用户不存在 / 禁用 → 永假条件', async () => {
    await expect(visibleRequirementFilter('')).resolves.toEqual({ id: { in: [] } })
    await expect(visibleRequirementFilter('u-ghost')).resolves.toEqual({ id: { in: [] } })
    await expect(visibleRequirementFilter('u-disabled')).resolves.toEqual({ id: { in: [] } })
  })

  it('普通成员（无部门，非 OWNER）：PUBLIC 限参与项目 + RESTRICTED 限本人 + PRIVATE 限责任人', async () => {
    await expect(visibleRequirementFilter('u-mem')).resolves.toEqual({
      OR: [
        { scope: 'PUBLIC', projectId: { in: ['p1'] } },
        {
          scope: 'RESTRICTED',
          OR: [{ scopeRefs: { path: ['userIds'], array_contains: 'u-mem' } }],
        },
        { scope: 'PRIVATE', OR: [{ ownerId: 'u-mem' }] },
      ],
    })
  })

  it('项目 OWNER：PRIVATE 额外放行本人任 OWNER 的项目', async () => {
    const w = (await visibleRequirementFilter('u-owner')) as {
      OR: Array<Record<string, unknown>>
    }
    const privateBranch = w.OR.find((b) => b.scope === 'PRIVATE') as {
      OR: Array<Record<string, unknown>>
    }
    expect(privateBranch.OR).toEqual([
      { ownerId: 'u-owner' },
      { scope: 'PRIVATE', projectId: { in: ['p1', 'pa'] } },
    ])
  })

  it('有部门用户：RESTRICTED 分支含 deptIds array_contains', async () => {
    const w = (await visibleRequirementFilter('u-mgr')) as {
      OR: Array<Record<string, unknown>>
    }
    const restricted = w.OR.find((b) => b.scope === 'RESTRICTED') as {
      OR: Array<Record<string, unknown>>
    }
    expect(restricted.OR).toEqual([
      { scopeRefs: { path: ['userIds'], array_contains: 'u-mgr' } },
      { scopeRefs: { path: ['deptIds'], array_contains: 'dept-elec' } },
    ])
  })

  it('非任何项目成员：无 PUBLIC 分支，仅 RESTRICTED(userIds)+PRIVATE(ownerId)', async () => {
    const w = (await visibleRequirementFilter('u-out')) as { OR: Array<Record<string, unknown>> }
    expect(w.OR.some((b) => b.scope === 'PUBLIC')).toBe(false)
    expect(w.OR.length).toBe(2) // RESTRICTED + PRIVATE
  })

  it('阶段负责人豁免：本人负责阶段下的 RESTRICTED 条目在列表中可见（与 can view 对齐）', async () => {
    // u-phase 是 ph1(PH01, p1) 的 owner；r-rst 为 RESTRICTED、phaseCode=PH01，scopeRefs 不含 u-phase
    expect(await can('u-phase', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(true)
    const w = (await visibleRequirementFilter('u-phase')) as { OR: Array<Record<string, unknown>> }
    expect(w.OR).toContainEqual({ OR: [{ projectId: 'p1', phaseCode: 'PH01' }] })
  })

  it('ACL 授 approve 豁免：非成员被授 approve 的条目在列表中可见（与 can view 对齐）', async () => {
    db.users.push({ id: 'u-acl', role: 'MEMBER', isActive: true, departmentId: null })
    db.acl.push({
      resourceType: 'FILE_REQ',
      resourceId: 'r-pri',
      principalType: 'USER',
      principalId: 'u-acl',
      perms: { approve: true },
    })
    expect(await can('u-acl', 'view', { type: 'FILE_REQ', id: 'r-pri' })).toBe(true)
    const w = (await visibleRequirementFilter('u-acl')) as { OR: Array<Record<string, unknown>> }
    expect(w.OR).toContainEqual({ id: { in: ['r-pri'] } })
  })

  it('RESTRICTED 非成员 scopeRefs 命中可见：定向授权不限项目成员（固化 issue② 语义）', async () => {
    // u-out 非任何项目成员，但 r-rst 的 scopeRefs.userIds 含 u-out
    expect(await can('u-out', 'view', { type: 'FILE_REQ', id: 'r-rst' })).toBe(true)
    const w = (await visibleRequirementFilter('u-out')) as { OR: Array<Record<string, unknown>> }
    const restricted = w.OR.find((b) => b.scope === 'RESTRICTED') as {
      OR: Array<Record<string, unknown>>
    }
    expect(restricted).toBeDefined()
    // RESTRICTED 分支仅按 scopeRefs 命中，未限定 projectId（定向授权可给项目外人员）
    expect(restricted.OR).toContainEqual({
      scopeRefs: { path: ['userIds'], array_contains: 'u-out' },
    })
    expect(restricted.OR.every((x) => x.projectId === undefined)).toBe(true)
  })
})

// ───────────────── 8. 合成矩阵抽查（三层叠加组合）─────────────────

describe('三层合成矩阵抽查（全局 × 项目 × ACL）', () => {
  const cases: Array<{
    name: string
    userId: string
    action: 'view' | 'edit' | 'delete' | 'assign' | 'upload' | 'download' | 'approve' | 'archive'
    res: { type: 'PROJECT' | 'PHASE' | 'TASK' | 'FILE_FOLDER' | 'FILE_REQ'; id: string }
    expect: boolean
  }> = [
    // 全局 ADMIN（无论项目/ACL 如何）
    { name: 'ADMIN×无成员×无ACL → true', userId: 'u-admin', action: 'delete', res: { type: 'TASK', id: 't1' }, expect: true },
    // 全局 PM
    { name: '全局PM×无成员×无ACL → false', userId: 'u-gpm', action: 'view', res: { type: 'PHASE', id: 'ph1' }, expect: false },
    { name: '全局PM×无成员×ACL(USER) → true', userId: 'u-gpm', action: 'archive', res: { type: 'TASK', id: 't2' }, expect: true },
    // 全局 MEMBER
    { name: '全局MEMBER×VIEWER×无ACL → false', userId: 'u-viewer', action: 'delete', res: { type: 'TASK', id: 't2' }, expect: false },
    { name: '全局MEMBER×VIEWER×ACL(ROLE:VIEWER) → true', userId: 'u-viewer', action: 'edit', res: { type: 'TASK', id: 't2' }, expect: true },
    { name: '全局MEMBER×MEMBER×无ACL → false', userId: 'u-mem', action: 'assign', res: { type: 'TASK', id: 't2' }, expect: false },
    { name: '全局MEMBER×MEMBER×ACL(USER) → true', userId: 'u-mem', action: 'edit', res: { type: 'TASK', id: 't2' }, expect: true },
    { name: '全局MEMBER×MANAGER×无ACL → true', userId: 'u-mgr', action: 'assign', res: { type: 'TASK', id: 't2' }, expect: true },
    { name: '全局MEMBER×MANAGER×无ACL delete → false', userId: 'u-mgr', action: 'delete', res: { type: 'TASK', id: 't2' }, expect: false },
    { name: '全局MEMBER×OWNER×无ACL → true', userId: 'u-owner', action: 'delete', res: { type: 'TASK', id: 't2' }, expect: true },
    // 阶段负责人维度
    { name: '阶段负责人(无成员身份)×task.* → true', userId: 'u-phase', action: 'delete', res: { type: 'TASK', id: 't1' }, expect: true },
    // ACL 维度补充
    { name: 'ACL(DEPARTMENT)×MANAGER → true', userId: 'u-mgr', action: 'upload', res: { type: 'TASK', id: 't2' }, expect: true },
    { name: 'ACL(USER:u-out)×非成员 → true', userId: 'u-out', action: 'delete', res: { type: 'TASK', id: 't2' }, expect: true },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      expect(await can(c.userId, c.action, c.res)).toBe(c.expect)
    })
  }
})
