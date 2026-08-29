/**
 * /api/purchase-requests —— 采购清单（成员提需求，2026-08-22 采购模块 Step 2）
 *
 * GET  我的相关清单（requesterId=me OR 成员项目；采购部/ADMIN 全量）分页 + 状态/项目筛选
 * POST 任何登录用户创建清单（items[] 明细；submit=true 直接提交流转到采购部）
 *
 * 编号规则：PR-{projectCode}-{3位流水}（同项目内递增，事务内 max+1）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  okPage,
  created,
  parsePagination,
  requireAuth,
  ApiError,
} from '@/lib/api-helpers'
import { visiblePurchaseRequestFilter } from '@/lib/data-visibility'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

// ───────────────────────────── 校验 ─────────────────────────────

const requestItemSchema = z.object({
  name: z.string().trim().min(1, '物料名称不能为空'),
  spec: z.string().trim().optional().nullable(),
  brand: z.string().trim().optional().nullable(),
  quantity: z.number().positive('数量必须大于 0'),
  unit: z.string().trim().min(1).default('件'),
  targetPrice: z.number().nonnegative().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
})

const createRequestSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  title: z.string().trim().min(1, '清单标题不能为空'),
  purpose: z.string().trim().optional().nullable(),
  category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'URGENT']).optional(),
  expectedArrivalDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  items: z.array(requestItemSchema).min(1, '至少一条物料明细'),
  submit: z.boolean().optional(), // true=直接提交（SUBMITTED），否则 DRAFT
})

/** 同项目内生成下一个编号（事务内调用，max+1） */
async function nextRequestCode(tx: Prisma.TransactionClient, projectCode: string): Promise<string> {
  const prefix = `PR-${projectCode}-`
  const last = await tx.purchaseRequest.findFirst({
    where: { code: { startsWith: prefix } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const seq = last ? parseInt(last.code.slice(prefix.length), 10) + 1 : 1
  return `${prefix}${String(seq).padStart(3, '0')}`
}

// ───────────────────────────── GET：列表 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { page, limit, skip } = parsePagination(request)
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const projectId = searchParams.get('projectId')

  // 可见性：ADMIN/采购部全量；其余=我提的 ∪ 成员项目的
  const visibility = await visiblePurchaseRequestFilter(user.userId, user.role)

  const where: Prisma.PurchaseRequestWhereInput = {
    ...visibility,
    ...(status && {
      status: status as Prisma.EnumPurchaseRequestStatusFilter['equals'],
    }),
    ...(projectId && { projectId }),
  }

  const [items, total] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where,
      include: {
        requester: { select: { id: true, name: true } },
        handler: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true, supplierRequests: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.purchaseRequest.count({ where }),
  ])

  return okPage(items, page, limit, total)
})

// ───────────────────────────── POST：创建 ─────────────────────────────

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createRequestSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw new ApiError(403, '项目已归档，无法提采购清单')

  const result = await prisma.$transaction(async (tx) => {
    const code = await nextRequestCode(tx, project.code)
    return tx.purchaseRequest.create({
      data: {
        projectId: body.projectId,
        code,
        title: body.title,
        purpose: body.purpose ?? null,
        category: body.category ?? 'OTHER',
        priority: body.priority ?? 'NORMAL',
        status: body.submit ? 'SUBMITTED' : 'DRAFT',
        expectedArrivalDate: body.expectedArrivalDate ? new Date(body.expectedArrivalDate) : null,
        requesterId: user.userId,
        remark: body.remark ?? null,
        items: {
          create: body.items.map((it) => ({
            name: it.name,
            spec: it.spec ?? null,
            brand: it.brand ?? null,
            quantity: it.quantity,
            unit: it.unit,
            targetPrice: it.targetPrice ?? null,
            remark: it.remark ?? null,
          })),
        },
      },
      include: {
        items: true,
        project: { select: { id: true, code: true, name: true } },
      },
    })
  })

  return created(result, body.submit ? '采购清单已提交到采购部' : '采购草稿已保存')
})
