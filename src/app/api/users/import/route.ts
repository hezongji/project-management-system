/**
 * /api/users/import —— 依据《开发文档-项目管理系统重构》§7.2、§10.7
 *
 * POST ADMIN  multipart/form-data：file=users.xlsx，可选 dryRun=1（只校验不写入）
 *
 * 列定义（§10.7）：姓名* 邮箱* 手机 部门(路径:技术部/资料组) 岗位 职责 初始密码(空=demo123456)
 *
 * 语义：
 *   - 邮箱为唯一键：不存在 → 创建；已存在 → 更新（姓名/手机/部门/岗位/职责；
 *     初始密码列填了才重置密码，未填不动）
 *   - username = 邮箱前缀；被其他账号占用且不属于本邮箱 → 该行报错
 *   - 部门按全路径精确匹配（「技术部/资料组」），找不到 → 该行报错
 *   - 岗位必须在岗位字典中（§10.1），不在 → 该行报错（先去岗位字典维护）
 *   - 响应：{ total, created, updated, errors:[{row,name,email,reason}], dryRun }
 */

import { NextRequest } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { parseUsersWorkbook, IMPORT_DEFAULT_PASSWORD, RowError } from '@/lib/excel-import'
import { loadDeptTree } from '@/lib/org-service'
import { flattenDeptPaths } from '@/lib/org-tree'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const form = await request.formData()
  const dryRun = form.get('dryRun') === '1'
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('请上传文件（表单字段名 file）')
  if (file.size === 0) throw ApiError.badRequest('上传的文件为空')
  if (file.size > 10 * 1024 * 1024) throw ApiError.badRequest('文件超过 10MB 上限')

  const name = file.name.toLowerCase()
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw ApiError.badRequest('仅支持 .xlsx / .xls 文件')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = parseUsersWorkbook(buffer) // 解析失败（空表/无表头）直接 throw → 400

  // 参照数据：部门全路径 → id；岗位字典名集合；已占用 username → email
  const [deptTree, jobTitles, existingUsers] = await Promise.all([
    loadDeptTree(),
    prisma.jobTitle.findMany({ select: { name: true } }),
    prisma.user.findMany({ select: { email: true, username: true } }),
  ])
  const deptIdByPath = flattenDeptPaths(deptTree)
  const jobTitleNames = new Set(jobTitles.map((t) => t.name))
  const emailSet = new Set(existingUsers.map((u) => u.email))
  const emailByUsername = new Map(existingUsers.map((u) => [u.username, u.email]))

  const errors: Array<RowError & { email?: string }> = [...parsed.errors]
  type Action = { kind: 'create' | 'update'; row: number; data: Record<string, unknown> }
  const actions: Action[] = []

  for (const r of parsed.rows) {
    // 部门路径校验（空 = 不挂部门）
    let departmentId: string | null = null
    if (r.deptPath) {
      departmentId = deptIdByPath.get(r.deptPath) ?? null
      if (!departmentId) {
        errors.push({ row: r.row, name: r.name, email: r.email, reason: `部门路径不存在：「${r.deptPath}」（须为完整路径，如 技术部/资料组）` })
        continue
      }
    }
    // 岗位校验（空 = 不设岗位）
    if (r.jobTitle && !jobTitleNames.has(r.jobTitle)) {
      errors.push({ row: r.row, name: r.name, email: r.email, reason: `岗位「${r.jobTitle}」不在岗位字典中，请先在岗位字典维护` })
      continue
    }
    // 初始密码校验
    if (r.password && r.password.length < 6) {
      errors.push({ row: r.row, name: r.name, email: r.email, reason: '初始密码至少 6 位' })
      continue
    }
    // username 生成与占用检查
    const username = r.email.split('@')[0]
    const occupiedBy = emailByUsername.get(username)
    const exists = emailSet.has(r.email)
    if (occupiedBy && occupiedBy !== r.email) {
      errors.push({ row: r.row, name: r.name, email: r.email, reason: `用户名「${username}」已被其他账号（${occupiedBy}）占用` })
      continue
    }

    actions.push({
      kind: exists ? 'update' : 'create',
      row: r.row,
      data: {
        email: r.email,
        username,
        name: r.name,
        phone: r.phone || null,
        departmentId,
        jobTitle: r.jobTitle || null,
        duties: r.duties || null,
        ...(r.password ? { password: r.password } : {}),
      },
    })
  }

  if (dryRun) {
    return ok({
      dryRun: true,
      total: parsed.rows.length + parsed.errors.length,
      validRows: actions.length,
      wouldCreate: actions.filter((a) => a.kind === 'create').length,
      wouldUpdate: actions.filter((a) => a.kind === 'update').length,
      errors,
    })
  }

  // 有效行全部落库（逐行 upsert：邮箱已存在 → 更新；bcrypt 仅在提供初始密码时计算）
  const defaultHash = await bcrypt.hash(IMPORT_DEFAULT_PASSWORD, 10)
  let createdCount = 0
  let updatedCount = 0
  for (const a of actions) {
    const d = a.data as {
      email: string
      username: string
      name: string
      phone: string | null
      departmentId: string | null
      jobTitle: string | null
      duties: string | null
      password?: string
    }
    const passwordHash = d.password ? await bcrypt.hash(d.password, 10) : defaultHash
    await prisma.user.upsert({
      where: { email: d.email },
      update: {
        name: d.name,
        phone: d.phone,
        departmentId: d.departmentId,
        jobTitle: d.jobTitle,
        duties: d.duties,
        ...(d.password ? { password: passwordHash } : {}),
      },
      create: {
        email: d.email,
        username: d.username,
        password: passwordHash,
        name: d.name,
        phone: d.phone,
        departmentId: d.departmentId,
        jobTitle: d.jobTitle,
        duties: d.duties,
        role: 'MEMBER',
        isActive: true,
      },
    })
    if (a.kind === 'create') createdCount++
    else updatedCount++
  }

  return ok({
    dryRun: false,
    total: parsed.rows.length + parsed.errors.length,
    created: createdCount,
    updated: updatedCount,
    errors,
  })
})
