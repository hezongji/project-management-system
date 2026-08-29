/**
 * /api/external-orgs/[id]/contacts/[contactId] —— 依据《开发文档-项目管理系统重构》§7.2
 *
 * PATCH   ADMIN  维护联系人 { name?, title?, phone?, email?, remark? }
 * DELETE  ADMIN  删除联系人
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; contactId: string }> }

const patchSchema = z.object({
  name: z.string().trim().min(1, '联系人姓名不能为空').max(50).optional(),
  title: z.string().trim().max(50).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  remark: z.string().trim().max(300).nullable().optional(),
})

export const PATCH = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { contactId, id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const contact = await prisma.externalContact.findUnique({
    where: { id: contactId },
  })
  if (!contact || contact.orgId !== id) throw ApiError.notFound('联系人不存在')

  const body = patchSchema.parse(await request.json())
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw ApiError.badRequest(`联系人邮箱格式不正确：${body.email}`)
  }

  const updated = await prisma.externalContact.update({
    where: { id: contact.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.title !== undefined ? { title: body.title || null } : {}),
      ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
      ...(body.email !== undefined ? { email: body.email || null } : {}),
      ...(body.remark !== undefined ? { remark: body.remark || null } : {}),
    },
  })
  return ok(updated, '联系人已更新')
})

export const DELETE = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { contactId, id } = await params
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const contact = await prisma.externalContact.findUnique({
    where: { id: contactId },
  })
  if (!contact || contact.orgId !== id) throw ApiError.notFound('联系人不存在')

  await prisma.externalContact.delete({ where: { id: contact.id } })
  return ok({ id: contact.id }, `联系人「${contact.name}」已删除`)
})
