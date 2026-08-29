/**
 * /api/admin/users —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * GET    ADMIN  用户管理列表（id/email/username/name/role/isActive/departmentId/jobTitle/duties/phone/lastLoginAt）
 *               支持 ?q= 搜索（name/email/username 模糊），分页（§4）
 * POST   ADMIN  新增用户（单人新增 UI 用）：{ name*, email*, username?, password*(≥6位必填), phone?, departmentId?, jobTitle?, duties?, role? }
 *               - 邮箱/用户名唯一性校验；用户名缺省取邮箱前缀，冲突自动加数字后缀
 *               - 密码 bcrypt 加密（与 /auth/register 同 12 轮）
 * PATCH  ADMIN  更新用户：{ userId, isActive?, role?, departmentId?, name?, email?, phone?, jobTitle?, duties? }
 *               - 启停 / 改全局角色 / 调部门 / 完善人员档案（audit P1-3）
 *               - role 校验 GlobalRole 枚举；departmentId 校验存在；email 唯一性冲突返回 400
 *               - 不可把最后一个 ADMIN 降级（防锁死）
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import { GlobalRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, parsePagination, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { invalidatePerms } from '@/lib/permission'

export const dynamic = 'force-dynamic'

const GLOBAL_ROLES = Object.values(GlobalRole)

// ───────────────────────────── GET：用户列表 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim()
  const { page, limit, skip } = parsePagination(request, 20)

  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
          { username: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {}

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        role: true,
        isActive: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        jobTitle: true,
        duties: true,
        phone: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
  ])

  const data = items.map((u) => ({
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    departmentId: u.departmentId,
    departmentName: u.department?.name ?? null,
    jobTitle: u.jobTitle,
    duties: u.duties,
    phone: u.phone,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  }))

  return ok({
    items: data,
    pagination: {
      page,
      limit,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  })
})

// ───────────────────────────── PATCH：更新用户 ─────────────────────────────

// ───────────────────────────── POST：新增用户 ─────────────────────────────

const postSchema = z.object({
  name: z.string().trim().min(1, '姓名不能为空').max(50),
  email: z.string().trim().min(1).max(200).toLowerCase().optional(),
  username: z
    .string()
    .trim()
    .min(2, '用户名至少 2 个字符')
    .max(50)
    .regex(/^[a-zA-Z0-9_.-]+$/, '用户名仅支持字母/数字/._-')
    .optional(),
  password: z.string().min(6, '密码至少 6 位').max(100),
  phone: z.string().trim().max(20).nullable().optional(),
  departmentId: z.string().nullable().optional(),
  jobTitle: z.string().trim().max(50).nullable().optional(),
  duties: z.string().trim().max(500).nullable().optional(),
  role: z.enum(GLOBAL_ROLES as [GlobalRole, ...GlobalRole[]]).optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const body = postSchema.parse(await request.json())

  // 用户名：优先显式传入；缺省取邮箱前缀，都没有则由姓名拼音生成；冲突自动加数字后缀
  const baseName = body.username ?? (body.email ? body.email.split('@')[0] : '')
  let username = baseName
  if (!username) {
    // 中文姓名→拼音（简易映射表覆盖常见姓氏与名字，不够准确时用 pinyin_x 兜底）
    const { cn2pin } = await import('@/lib/pinyin')
    username = cn2pin(body.name) || `user${Date.now().toString(36).slice(-6)}`
  }
  {
    let prefix = username
    let suffix = 0
    // eslint-disable-next-line no-await-in-loop
    while (await prisma.user.findUnique({ where: { username }, select: { id: true } })) {
      suffix += 1
      username = `${prefix}${suffix}`
    }
  }

  // 邮箱：没传则自动生成占位（保证 unique 非空约束），优先用 username
  const email = body.email ?? `${username}@local.invalid`

  // 邮箱唯一性预检查（友好 400，避免撞 DB unique 约束返回 500）
  if (body.email) {
    const dupEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true } })
    if (dupEmail) throw ApiError.badRequest(`邮箱已被「${dupEmail.name}」占用`)
  }

  // 部门存在性
  if (body.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: body.departmentId } })
    if (!dept) throw ApiError.badRequest('所选部门不存在')
  }

  const hashedPassword = await bcrypt.hash(body.password, 12)

  const user = await prisma.user.create({
    data: {
      email,
      username,
      password: hashedPassword,
      name: body.name,
      phone: body.phone ?? null,
      departmentId: body.departmentId ?? null,
      jobTitle: body.jobTitle ?? null,
      duties: body.duties ?? null,
      role: body.role ?? 'MEMBER',
      isActive: true,
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      role: true,
      isActive: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      jobTitle: true,
      duties: true,
      phone: true,
    },
  })

  return created(
    {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      departmentId: user.departmentId,
      departmentName: user.department?.name ?? null,
      jobTitle: user.jobTitle,
      duties: user.duties,
      phone: user.phone,
    },
    '用户已创建'
  )
})

const patchSchema = z.object({
  userId: z.string().min(1, 'userId 不能为空'),
  isActive: z.boolean().optional(),
  role: z.enum(GLOBAL_ROLES as [GlobalRole, ...GlobalRole[]]).optional(),
  departmentId: z.string().nullable().optional(),
  // audit P1-3：人员档案完善字段
  name: z.string().trim().min(1, '姓名不能为空').max(50).optional(),
  email: z.string().trim().min(1, '邮箱不能为空').max(200).toLowerCase().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  jobTitle: z.string().trim().max(50).nullable().optional(),
  duties: z.string().trim().max(500).nullable().optional(),
})

export const PATCH = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const body = patchSchema.parse(await request.json())

  const target = await prisma.user.findUnique({ where: { id: body.userId } })
  if (!target) throw ApiError.notFound('用户不存在')

  // 角色枚举已由 zod 校验；部门存在性校验
  if (body.departmentId !== undefined && body.departmentId !== null) {
    const dept = await prisma.department.findUnique({ where: { id: body.departmentId } })
    if (!dept) throw ApiError.badRequest('目标部门不存在')
  }

  // email 唯一性冲突检查（排除自己）
  if (body.email !== undefined && body.email !== target.email) {
    const dup = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true, name: true } })
    if (dup) throw ApiError.badRequest(`邮箱已被「${dup.name}」占用，无法修改`)
  }

  // 防锁死：最后一个 ADMIN 不可被降级或停用
  if (target.role === 'ADMIN' && ((body.role !== undefined && body.role !== 'ADMIN') || body.isActive === false)) {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN', isActive: true } })
    if (adminCount <= 1) {
      throw ApiError.badRequest('系统至少需保留一名 ADMIN，无法降级或停用最后一名管理员')
    }
  }

  const updated = await prisma.user.update({
    where: { id: body.userId },
    data: {
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone === '' ? null : body.phone } : {}),
      ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle === '' ? null : body.jobTitle } : {}),
      ...(body.duties !== undefined ? { duties: body.duties === '' ? null : body.duties } : {}),
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      role: true,
      isActive: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      jobTitle: true,
      duties: true,
      phone: true,
      lastLoginAt: true,
    },
  })

  // 部门/角色/启停影响权限判定（ACL DEPARTMENT/ROLE 匹配与 isActive 短路）→ 失效该用户权限缓存
  if (
    body.departmentId !== undefined ||
    body.isActive !== undefined ||
    body.role !== undefined
  ) {
    invalidatePerms(body.userId)
  }

  return ok(
    {
      id: updated.id,
      email: updated.email,
      username: updated.username,
      name: updated.name,
      role: updated.role,
      isActive: updated.isActive,
      departmentId: updated.departmentId,
      departmentName: updated.department?.name ?? null,
      jobTitle: updated.jobTitle,
      duties: updated.duties,
      phone: updated.phone,
      lastLoginAt: updated.lastLoginAt,
    },
    '用户已更新'
  )
})
