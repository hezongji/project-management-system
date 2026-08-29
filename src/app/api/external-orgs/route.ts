/**
 * /api/external-orgs —— 依据《开发文档-项目管理系统重构》§7.2、§5 ExternalOrg
 *
 * GET   登录   外部主体列表 ?type=CUSTOMER&q=&page=&limit=（分页+搜索，附联系人）
 * POST  ADMIN  新建外部主体 { name, type, phone?, address?, remark?, isActive? }
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ExternalOrgType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, okPage, created, requireAuth, requireRole, ApiError, parsePagination } from '@/lib/api-helpers'
import { visibleExternalOrgFilter } from '@/lib/data-visibility'

export const dynamic = 'force-dynamic'

const VALID_TYPES = Object.values(ExternalOrgType)

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || undefined
  if (type && !VALID_TYPES.includes(type as ExternalOrgType)) {
    throw ApiError.badRequest(`无效的类型筛选：${type}（可选：${VALID_TYPES.join('/')}）`)
  }
  const q = (searchParams.get('q') || '').trim()
  const { page, limit, skip } = parsePagination(request, 20)

  // 权限 V2 可见性：供应商仅采购部；客户/外协/承包商仅成员项目关联；ADMIN 全量
  const visibilityWhere = await visibleExternalOrgFilter(user.userId, user.role)

  const where = {
    ...(type ? { type: type as ExternalOrgType } : {}),
    ...visibilityWhere,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { phone: { contains: q } },
            { remark: { contains: q, mode: 'insensitive' as const } },
            { contacts: { some: { name: { contains: q } } } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.externalOrg.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip,
      take: limit,
      include: {
        contacts: { orderBy: [{ name: 'asc' }] },
        _count: { select: { contacts: true } },
      },
    }),
    prisma.externalOrg.count({ where }),
  ])

  return okPage(items, page, limit, total)
})

const createSchema = z.object({
  name: z.string().trim().min(1, '主体名称不能为空').max(120),
  type: z.nativeEnum(ExternalOrgType),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  remark: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN', 'PROJECT_MANAGER')

  const body = createSchema.parse(await request.json())
  const dup = await prisma.externalOrg.findFirst({ where: { name: body.name, type: body.type } })
  if (dup) throw new ApiError(409, `同类型下已存在主体「${body.name}」`, 'CONFLICT')

  const org = await prisma.externalOrg.create({
    data: {
      name: body.name,
      type: body.type,
      phone: body.phone || null,
      address: body.address || null,
      remark: body.remark || null,
      isActive: body.isActive ?? true,
    },
    include: { contacts: true },
  })
  return created(org, '外部主体已创建')
})
