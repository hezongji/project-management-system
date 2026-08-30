/**
 * 网盘域共享库（20260830-drive-war W2）
 *
 * 职责：目录树软删/恢复/彻底删除（path 物化列驱动，无递归 CTE）、SYSTEM 目录保护、
 * 祖先链 breadcrumb、回收站保留期计算。供 catalogs / drive / files 系列路由与
 * scripts/drive-purge-recycle.ts 复用。
 *
 * 语义（spec §3.2/§3.3）：
 *  - folderPerm = 项目角色基线 ∪ 祖先链 ACL（permission.ts FILE_FOLDER 分支实现）
 *  - MEMBER 文件夹基线 = view+upload+edit+download；delete 留给 MANAGER/OWNER
 *  - SYSTEM 目录：全员禁删/禁改名/禁移动；其下建目录/传自由文件仅 MANAGER+/ADMIN（应急）
 *  - 软删整树 = catalog 子树（path 前缀）+ 子树内全部活跃文件打 deletedAt
 *  - 恢复 = 整树清除 deletedAt（要求全部祖先目录存活）
 *  - purge = 物理删除（FileAccessLog SetNull 保留审计）
 */

import { prisma } from './prisma'
import { ApiError } from './api-helpers'

// ───────────────────────────── 常量 ─────────────────────────────

/** 回收站保留天数（env 可调，spec D3=30） */
export function recycleRetainDays(): number {
  const n = Number(process.env.DRIVE_RECYCLE_RETAIN_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 30
}

export interface FolderBrief {
  id: string
  projectId: string
  parentId?: string | null
  name: string
  kind: 'SYSTEM' | 'USER'
  path: string
  deletedAt: Date | null
}

// ───────────────────────────── 目录定位与校验 ─────────────────────────────

/** 取目录（须存活=未软删）；不存在或已删 → 404 */
export async function getLiveFolder(id: string, projectId?: string): Promise<FolderBrief> {
  const folder = await prisma.fileCatalog.findUnique({
    where: { id },
    select: { id: true, projectId: true, parentId: true, name: true, kind: true, path: true, deletedAt: true },
  })
  if (!folder || folder.deletedAt) throw ApiError.notFound('目录不存在或已在回收站')
  if (projectId && folder.projectId !== projectId) throw ApiError.badRequest('目录不属于该项目')
  return folder
}

/** path → 祖先目录 id 数组（含自身） */
export function pathIds(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 面包屑：path → [{id,name}]（一次 in 查询） */
export async function breadcrumb(folder: FolderBrief): Promise<{ id: string; name: string; kind: string }[]> {
  const ids = pathIds(folder.path)
  if (ids.length === 0) return []
  const rows = await prisma.fileCatalog.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, kind: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: { id: string; name: string; kind: string }[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (r) out.push({ id: r.id, name: r.name, kind: r.kind as string })
  }
  return out
}

/** 用户在某项目的成员角色（非成员 null；ADMIN 识别另行判断） */
export async function memberRoleOf(userId: string, projectId: string): Promise<string | null> {
  const m = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  })
  return m?.role ?? null
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } })
  return !!u && u.isActive && u.role === 'ADMIN'
}

/** MANAGER 及以上（含 ADMIN）——SYSTEM 目录应急管理与删除/恢复权限门槛 */
export async function isManagerPlus(userId: string, projectId: string): Promise<boolean> {
  if (await isAdminUser(userId)) return true
  const role = await memberRoleOf(userId, projectId)
  return role === 'MANAGER' || role === 'OWNER'
}

/** SYSTEM 目录不可作为「自由建目录/自由上传」目标（MANAGER+ 应急例外） */
export async function assertFolderUsableAsTarget(userId: string, folder: FolderBrief): Promise<void> {
  if (folder.kind === 'SYSTEM') {
    const ok = await isManagerPlus(userId, folder.projectId)
    if (!ok) {
      throw ApiError.forbidden('系统目录（交付计划）内仅支持按条目流程上传；自由文件请放在自建目录')
    }
  }
}

// ───────────────────────────── path 维护 ─────────────────────────────

/** 新建目录后的 path（父 path + /selfId） */
export function childPath(parentPath: string | null, selfId: string): string {
  return parentPath ? `${parentPath}/${selfId}` : `/${selfId}`
}

/**
 * 目录移动后重算整棵子树 path（含自身）。
 * 事务内执行：UPDATE ... SET path = 新前缀 || substring(path, 旧前缀长度+1)
 */
export async function rewriteSubtreePaths(
  tx: { $executeRaw: Function },
  folderId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "FileCatalog"
    SET path = ${newPath} || substring(path from ${oldPath.length + 1})
    WHERE id = ${folderId} OR path LIKE ${oldPath + '/%'}`
}

// ───────────────────────────── 子树与软删 ─────────────────────────────

/** 子树全部目录 id（含自身）——path 前缀匹配 */
export async function subtreeCatalogIds(folderId: string, folderPath: string): Promise<string[]> {
  const rows = await prisma.fileCatalog.findMany({
    where: { OR: [{ id: folderId }, { path: { startsWith: folderPath + '/' } }] },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** 软删整树：目录子树 + 子树内全部活跃文件打标 */
export async function softDeleteTree(
  folder: FolderBrief,
  userId: string,
  tx?: { fileCatalog: any; file: any },
): Promise<{ folders: number; files: number }> {
  const ids = await subtreeCatalogIds(folder.id, folder.path)
  const now = new Date()
  const client = tx ?? prisma
  const f = await client.fileCatalog.updateMany({
    where: { id: { in: ids }, deletedAt: null },
    data: { deletedAt: now, deletedById: userId },
  })
  const files = await client.file.updateMany({
    where: { folderId: { in: ids }, deletedAt: null },
    data: { deletedAt: now, deletedById: userId },
  })
  return { folders: f.count, files: files.count }
}

/** 恢复整树：要求全部祖先目录存活；清除子树软删标 */
export async function restoreTree(
  folder: FolderBrief,
): Promise<{ folders: number; files: number }> {
  // 祖先链检查：path 去掉最后一段 = 祖先 ids
  const ids = pathIds(folder.path)
  const ancestorIds = ids.slice(0, -1)
  if (ancestorIds.length > 0) {
    const dead = await prisma.fileCatalog.count({
      where: { id: { in: ancestorIds }, deletedAt: { not: null } },
    })
    if (dead > 0) throw ApiError.badRequest('上级目录仍在回收站，请先恢复上级目录')
  }
  const subtree = await subtreeCatalogIds(folder.id, folder.path)
  const f = await prisma.fileCatalog.updateMany({
    where: { id: { in: subtree }, deletedAt: { not: null } },
    data: { deletedAt: null, deletedById: null },
  })
  const files = await prisma.file.updateMany({
    where: { folderId: { in: subtree }, deletedAt: { not: null } },
    data: { deletedAt: null, deletedById: null },
  })
  return { folders: f.count, files: files.count }
}

/** 物理删除整树（purge）：先删子树内文件（含磁盘清理 best-effort），再叶子优先删目录 */
export async function purgeTree(folder: FolderBrief, userId: string): Promise<{ folders: number; files: number }> {
  const ids = await subtreeCatalogIds(folder.id, folder.path)
  const files = await prisma.file.findMany({
    where: { folderId: { in: ids } },
    select: { id: true, storagePath: true },
  })
  // 审计先行（File 行删除后 SetNull 保留日志）
  await prisma.fileAccessLog.createMany({
    data: files.map((f) => ({ fileId: f.id, userId, action: 'PURGE' as const })),
  })
  const delFiles = await prisma.file.deleteMany({ where: { id: { in: files.map((f) => f.id) } } })
  // 磁盘清理（事务外语义，best-effort）
  const { resolveStoredFile } = await import('./file-storage')
  const { unlink } = await import('fs/promises')
  for (const f of files) {
    const abs = resolveStoredFile(f.storagePath)
    if (abs) await unlink(abs).catch(() => {})
  }
  // 目录叶子优先（path 长度降序 = 深度优先）
  const catalogs = await prisma.fileCatalog.findMany({
    where: { id: { in: ids } },
    select: { id: true, path: true },
    orderBy: { path: 'desc' },
  })
  let folders = 0
  for (const c of catalogs) {
    await prisma.fileCatalog.delete({ where: { id: c.id } })
    folders++
  }
  return { folders, files: delFiles.count }
}

/** 回收站剩余保留天数（向上取整；过期=0） */
export function retainDaysLeft(deletedAt: Date): number {
  const ms = deletedAt.getTime() + recycleRetainDays() * 86400_000 - Date.now()
  return Math.max(0, Math.ceil(ms / 86400_000))
}

/** 同目录同名活跃自由文件（版本合并判定，spec D4） */
export async function latestActiveVersion(folderId: string, originalName: string) {
  return prisma.file.findFirst({
    where: { folderId, originalName, requirementId: null, deletedAt: null },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  })
}

// ───────────────────── 文件级回收站操作（batch 端点用） ─────────────────────

export interface FileRef {
  id: string
  projectId: string
  folderId: string | null
  requirementId: string | null
  originalName?: string
  deletedAt: Date | null
  storagePath?: string
}

/** 取目录（含已删，供回收站操作） */
export async function getLiveFolderById(id: string) {
  const folder = await prisma.fileCatalog.findUnique({
    where: { id },
    select: { id: true, projectId: true, parentId: true, name: true, kind: true, path: true, deletedAt: true },
  })
  if (!folder) throw ApiError.notFound('目录不存在')
  return folder
}

/**
 * 版本家族 id 集（自由文件）：同 folderId+originalName 的一家版本行。
 * ★ 家族语义：列表只展示最新版，单行删除/移动/重命名必须作用全家，否则旧版本会「浮出」或拆家。
 * 条目文件（requirementId 非空）返回单行（沿用条目版本流程语义）。
 */
async function familyIds(file: FileRef, among: 'active' | 'deleted'): Promise<string[]> {
  if (file.requirementId || !file.folderId || !file.originalName) return [file.id]
  const rows = await prisma.file.findMany({
    where: {
      folderId: file.folderId,
      originalName: file.originalName,
      requirementId: null,
      deletedAt: among === 'active' ? null : { not: null },
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** 软删文件（家族整组打标 + DELETE 审计） */
export async function softDeleteFile(file: FileRef, userId: string): Promise<number> {
  const ids = await familyIds({ ...file, deletedAt: null }, 'active')
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.file.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: now, deletedById: userId },
    })
    await tx.fileAccessLog.createMany({
      data: ids.map((id) => ({ fileId: id, userId, action: 'DELETE' as const })),
    })
  })
  return ids.length
}

/** 恢复文件（家族整组；所在目录须存活） */
export async function restoreFile(file: FileRef, userId: string): Promise<number> {
  if (file.folderId) {
    const folder = await prisma.fileCatalog.findUnique({
      where: { id: file.folderId },
      select: { deletedAt: true },
    })
    if (folder?.deletedAt) {
      throw ApiError.badRequest('所在目录仍在回收站，请先恢复上级目录')
    }
  }
  const ids = await familyIds(file, 'deleted')
  await prisma.$transaction(async (tx) => {
    await tx.file.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: null, deletedById: null },
    })
    await tx.fileAccessLog.createMany({
      data: ids.map((id) => ({ fileId: id, userId, action: 'RESTORE' as const })),
    })
  })
  return ids.length
}

/** 物理删除文件（家族整组硬删：审计先行 SetNull 保留 + DB 删 + 磁盘 best-effort） */
export async function purgeFile(file: FileRef, userId: string): Promise<number> {
  const ids = await familyIds(file, 'deleted')
  const rows = await prisma.file.findMany({
    where: { id: { in: ids } },
    select: { id: true, storagePath: true },
  })
  await prisma.fileAccessLog.createMany({
    data: rows.map((r) => ({ fileId: r.id, userId, action: 'PURGE' as const })),
  })
  await prisma.file.deleteMany({ where: { id: { in: ids } } })
  const { resolveStoredFile } = await import('./file-storage')
  const { unlink } = await import('fs/promises')
  for (const r of rows) {
    if (r.storagePath) {
      const abs = resolveStoredFile(r.storagePath)
      if (abs) await unlink(abs).catch(() => {})
    }
  }
  return ids.length
}

/** 计算目录下文件列表应展示的「最新版本行」过滤（同 folderId+originalName 取 max version） */
export function latestVersionFilter<T extends { id: string; originalName: string; version: number }>(rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const r of rows) {
    const key = r.originalName
    const cur = best.get(key)
    if (!cur || r.version > cur.version) best.set(key, r)
  }
  return Array.from(best.values())
}
