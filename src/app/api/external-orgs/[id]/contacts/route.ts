/**
 * /api/external-orgs/[id]/contacts —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * GET   登录   某外部主体的联系人列表
 * POST  ADMIN  新增联系人 { name, title?, phone?, email?, remark? }
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, created, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  requireAuth(request)

  const org = await prisma.externalOrg.findUnique({ where: { id: id } })
  if (!org) throw ApiError.notFound('外部主体不存在')

  const contacts = await prisma.externalContact.findMany({
    where: { orgId: org.id },
    orderBy: [{ name: 'asc' }],
  })
  return ok({ items: contacts })
})

const createSchema = z.object({
  name: z.string().trim().min(1, '联系人姓名不能为空').max(50),
  title: z.string().trim().max(50).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  remark: z.string().trim().max(300).nullable().optional(),
})

export const POST = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const org = await prisma.externalOrg.findUnique({ where: { id: id } })
  if (!org) throw ApiError.notFound('外部主体不存在')

  const body = createSchema.parse(await request.json())
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw ApiError.badRequest(`联系人邮箱格式不正确：${body.email}`)
  }

  const contact = await prisma.externalContact.create({
    data: {
      orgId: org.id,
      name: body.name,
      title: body.title || null,
      phone: body.phone || null,
      email: body.email || null,
      remark: body.remark || null,
    },
  })
  return created(contact, '联系人已添加')
})
