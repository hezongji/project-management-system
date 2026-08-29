/**
 * /api/supplier-requests —— 采购需求（采购分解清单 + RFQ 询价）
 *
 * GET  列表：ADMIN/采购部全量；其余=成员项目的；按项目/状态/供应商筛选
 * POST 采购部/ADMIN 创建（从清单分解：requestId + items 溯源；或独立发起）
 *      编号 SR-{projectCode}-{3位流水}；创建时来源清单置 DECOMPOSED、
 *      来源明细 allocatedQty 累加回写（事务内）
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
import {
  getUserDeptName,
  isPurchaseDept,
  visibleSupplierRequestScope,
} from '@/lib/data-visibility'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const supplierItemSchema = z.object({
  name: z.string().trim().min(1, '物料名称不能为空'),
  spec: z.string().trim().optional().nullable(),
  brand: z.string().trim().optional().nullable(),
  quantity: z.number().positive('数量必须大于 0'),
  unit: z.string().trim().min(1).default('件'),
  unitPrice: z.number().nonnegative().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  // 溯源：来自哪些清单条目（PurchaseRequestItem.id 数组）
  sourceRequestItemIds: z.array(z.string()).optional(),
})

const createSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  supplierId: z.string().min(1, '请选择供应商'),
  requestId: z.string().optional().nullable(), // 来源采购清单（可选=独立发起）
  title: z.string().trim().optional().nullable(),
  category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
  expectedDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  publish: z.boolean().optional(), // true=直接发布 PUBLISHED，否则 DRAFT
  items: z.array(supplierItemSchema).min(1, '至少一条物料明细'),
})

/** 同项目内生成下一个 SR 编号 */
async function nextSupplierRequestCode(
  tx: Prisma.TransactionClient,
  projectCode: string,
): Promise<string> {
  const prefix = `SR-${projectCode}-`
  const last = await tx.supplierRequest.findFirst({
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
  const supplierId = searchParams.get('supplierId')

  // ★ Step3：可见性统一走 visibleSupplierRequestScope（硬性要求 C：ADMIN/采购部全量；
  // 其余=创建人 ∪ 溯源清单发布人 ∪ 被授权，项目成员不再可见）
  const visibility = await visibleSupplierRequestScope(user.userId, user.role)

  const where: Prisma.SupplierRequestWhereInput = {
    ...visibility,
    ...(status && { status: status as Prisma.EnumSupplierRequestStatusFilter['equals'] }),
    ...(projectId && { projectId }),
    ...(supplierId && { supplierId }),
  }

  const [items, total] = await Promise.all([
    prisma.supplierRequest.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        request: { select: { id: true, code: true, title: true } },
        creator: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true } },
        order: { select: { id: true, code: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.supplierRequest.count({ where }),
  ])

  return okPage(items, page, limit, total)
})

// ───────────────────────────── POST：创建（分解/独立） ─────────────────────────────

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  // 仅采购部/ADMIN 可创建采购需求（分解动作是采购职责）
  const deptName = await getUserDeptName(user.userId)
  if (user.role !== 'ADMIN' && !isPurchaseDept(deptName)) {
    throw ApiError.forbidden('仅采购部可创建采购需求')
  }

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')

  const supplier = await prisma.externalOrg.findUnique({
    where: { id: body.supplierId },
    select: { id: true, type: true, name: true },
  })
  if (!supplier || supplier.type !== 'SUPPLIER') {
    throw ApiError.badRequest('供应商不存在或类型不是 SUPPLIER')
  }
  if (body.requestId) {
    const srcReq = await prisma.purchaseRequest.findUnique({
      where: { id: body.requestId },
      select: { id: true, projectId: true, status: true },
    })
    if (!srcReq) throw ApiError.notFound('来源采购清单不存在')
    if (srcReq.projectId !== body.projectId) {
      throw ApiError.badRequest('来源清单与项目不一致')
    }
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const code = await nextSupplierRequestCode(tx, project.code)

    const sr = await tx.supplierRequest.create({
      data: {
        projectId: body.projectId,
        code,
        supplierId: body.supplierId,
        requestId: body.requestId ?? null,
        title: body.title ?? null,
        category: body.category ?? 'OTHER',
        status: body.publish ? 'PUBLISHED' : 'DRAFT',
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        creatorId: user.userId,
        remark: body.remark ?? null,
        items: {
          create: body.items.map((it) => ({
            name: it.name,
            spec: it.spec ?? null,
            brand: it.brand ?? null,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice ?? null,
            remark: it.remark ?? null,
            sourceRequestItemIds: it.sourceRequestItemIds ?? [],
          })),
        },
      },
      include: { items: true, supplier: { select: { id: true, name: true } } },
    })

    // 来源清单回写：置 DECOMPOSED（PROCESSING/SUBMITTED 时）+ 记录 handler + allocatedQty 累加
    if (body.requestId) {
      const srcReq = await tx.purchaseRequest.findUnique({
        where: { id: body.requestId },
        select: { id: true, status: true, handlerId: true },
      })
      if (srcReq) {
        await tx.purchaseRequest.update({
          where: { id: body.requestId },
          data: {
            ...(srcReq.status === 'PROCESSING' || srcReq.status === 'SUBMITTED'
              ? { status: 'DECOMPOSED' as const }
              : {}),
            ...(srcReq.handlerId ? {} : { handlerId: user.userId }),
          },
        })
      }
      // allocatedQty 累加回写（按溯源 itemIds；无溯源则按名称+规格匹配兜底）
      for (const it of body.items) {
        const qty = it.quantity
        if (it.sourceRequestItemIds && it.sourceRequestItemIds.length > 0) {
          for (const sid of it.sourceRequestItemIds) {
            const target = await tx.purchaseRequestItem.findUnique({
              where: { id: sid },
              select: { id: true, requestId: true },
            })
            if (target && target.requestId === body.requestId) {
              await tx.purchaseRequestItem.update({
                where: { id: sid },
                data: { allocatedQty: { increment: qty } },
              })
            }
          }
        }
      }
    }

    return sr
  })

  return created(result, body.publish ? '采购需求已发布' : '采购需求已保存（草稿）')
})
