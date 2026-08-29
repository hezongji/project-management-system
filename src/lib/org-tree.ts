/**
 * 组织架构服务端工具 —— 依据《开发文档-项目管理系统重构》§5、§7.2
 *
 * - DeptNode：部门树节点（GET /departments、GET /org-chart 共用）
 * - buildDeptTree：扁平列表 → 树（含成员数、负责人、在职成员摘要）
 * - flattenDeptPaths：树 → 「技术部/资料组」路径映射（Excel 导入部门列解析用）
 */

import type { GlobalRole } from '@prisma/client'

/** 部门成员摘要（树内嵌，51 人量级全量返回无压力） */
export interface DeptMemberBrief {
  id: string
  name: string
  email: string
  jobTitle: string | null
  duties: string | null
  phone: string | null
  avatar: string | null
  role: GlobalRole
  isActive: boolean
  /** 入职时间（新建项目向导岗位自动匹配预演用：与 phase-engine 同款 createdAt 升序取第一人） */
  createdAt: Date
}

export interface DeptNode {
  id: string
  name: string
  parentId: string | null
  sort: number
  managerId: string | null
  manager: { id: string; name: string } | null
  memberCount: number
  /** 本部门直属在职成员 */
  members: DeptMemberBrief[]
  children: DeptNode[]
}

/** 部门原始记录（prisma findMany + include members 的输入形状） */
export interface DeptRecord {
  id: string
  name: string
  parentId: string | null
  sort: number
  managerId: string | null
  members: Array<{
    id: string
    name: string
    email: string
    jobTitle: string | null
    duties: string | null
    phone: string | null
    avatar: string | null
    role: string
    isActive: boolean
    createdAt: Date
  }>
}

/** 扁平部门列表 → DeptNode 树（按 sort 升序，name 兜底排序） */
export function buildDeptTree(
  records: DeptRecord[],
  managerNameById: Map<string, string>
): DeptNode[] {
  const byId = new Map<string, DeptNode>()
  for (const r of records) {
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      sort: r.sort,
      managerId: r.managerId,
      manager:
        r.managerId && managerNameById.has(r.managerId)
          ? { id: r.managerId, name: managerNameById.get(r.managerId)! }
          : null,
      memberCount: r.members.filter((m) => m.isActive).length,
      members: r.members
        .filter((m) => m.isActive)
        .map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          jobTitle: m.jobTitle,
          duties: m.duties,
          phone: m.phone,
          avatar: m.avatar,
          role: m.role as GlobalRole,
          isActive: m.isActive,
          createdAt: m.createdAt,
        })),
      children: [],
    })
  }

  const roots: DeptNode[] = []
  const nodes = Array.from(byId.values()).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh'))
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/** 树 → 路径映射（「技术部」/「技术部/资料组」→ id），Excel 导入部门列解析用 */
export function flattenDeptPaths(tree: DeptNode[]): Map<string, string> {
  const map = new Map<string, string>()
  function walk(node: DeptNode, prefix: string) {
    const path = prefix ? `${prefix}/${node.name}` : node.name
    map.set(path, node.id)
    for (const child of node.children) walk(child, path)
  }
  for (const root of tree) walk(root, '')
  return map
}

/** 收集节点及其全部后代 id（PATCH 换父部门时的循环引用检测用） */
export function collectDescendantIds(node: DeptNode): Set<string> {
  const ids = new Set<string>()
  function walk(n: DeptNode) {
    for (const c of n.children) {
      ids.add(c.id)
      walk(c)
    }
  }
  walk(node)
  return ids
}

/** 部门全路径显示（页面面包屑用） */
export function deptPathOf(tree: DeptNode[], id: string): string {
  function walk(node: DeptNode, prefix: string): string | null {
    const path = prefix ? `${prefix} / ${node.name}` : node.name
    if (node.id === id) return path
    for (const c of node.children) {
      const hit = walk(c, path)
      if (hit) return hit
    }
    return null
  }
  for (const root of tree) {
    const hit = walk(root, '')
    if (hit) return hit
  }
  return ''
}
