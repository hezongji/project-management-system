/**
 * /api/purchase-orders —— 采购订单（订单=合同）
 *
 * GET  列表：visiblePurchaseOrderFilter（★ V3 硬性要求 C：ADMIN/采购部全量，
 *      其余=creator/owner/receiver/发布人链路/被授权，不再按成员项目放行）
 *      + 项目/类别/状态/供应商筛选 + 统计卡（待下单/在途/已完成/总金额[按权限脱敏]）
 * POST 创建：采购部 / 项目 OWNER|MANAGER（requireCan edit）/ ADMIN
 *      编号 CG-{projectCode}-{3位流水}（事务内生成，统一走 src/lib/purchase-codes.ts）；可关联 supplierRequestId
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  apiHandler,
  ok,
  created,
  parsePagination,
  requireAuth,
  ApiError,
} from '@/lib/api-helpers'
import {
  visiblePurchaseOrderFilter,
  getUserDeptName,
  isPurchaseDept,
  canViewPurchaseFinanceOf,
  maskPurchaseFinance,
} from '@/lib/data-visibility'
import { requireCan } from '@/lib/permission'
import { nextPurchaseOrderCode } from '@/lib/purchase-codes'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** 当月零点（本地时区） */
function monthStart(): Date {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

const orderItemSchema = z.object({
  name: z.string().trim().min(1, '物料名称不能为空'),
  spec: z.string().trim().optional().nullable(),
  brand: z.string().trim().optional().nullable(),
  quantity: z.number().positive('数量必须大于 0'),
  unit: z.string().trim().min(1).default('件'),
  unitPrice: z.number().nonnegative().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
})

const createSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  title: z.string().trim().min(1, '订单标题不能为空'),
  category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
  supplierId: z.string().optional().nullable(),
  items: z.array(orderItemSchema).min(1, '至少一条订单明细'),
  isSupplementary: z.boolean().optional(),
  supplementaryReason: z.string().trim().optional().nullable(),
  supplementaryOfId: z.string().optional().nullable(),
  supplierRequestId: z.string().optional().nullable(),
  orderDate: z.string().datetime().optional().nullable(),
  plannedArrivalDate: z.string().datetime().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  submit: z.boolean().optional(), // true=直接下单 ORDERED，否则 DRAFT
})

/** 创建/流转权限：采购部 / ADMIN / 项目 edit（OWNER|MANAGER） */
async function assertOrderWriter(userId: string, role: string, projectId: string) {
  if (role === 'ADMIN') return
  const deptName = await getUserDeptName(userId)
  if (isPurchaseDept(deptName)) return
  await requireCan(userId, 'edit', { type: 'PROJECT', id: projectId })
}

// ───────────────────────────── GET：列表 + 统计 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const { page, limit, skip } = parsePagination(request)
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const projectId = searchParams.get('projectId')
  const category = searchParams.get('category')
  const supplierId = searchParams.get('supplierId')

  const visibility = await visiblePurchaseOrderFilter(user.userId, user.role)

  const where: Prisma.PurchaseOrderWhereInput = {
    ...visibility,
    ...(status && { status: status as Prisma.EnumPurchaseOrderStatusFilter['equals'] }),
    ...(projectId && { projectId }),
    ...(category && { category: category as Prisma.EnumPurchaseCategoryFilter['equals'] }),
    ...(supplierId && { supplierId }),
  }

  const [items, total, statusGroups, monthAgg] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true, arrivals: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
    // 统计（同可见性范围）：按状态分组计数 + 金额合计
    prisma.purchaseOrder.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    // 本月金额（同可见性范围；口径：按 orderDate 即「下单月份」统计，未下单的草稿 orderDate 为 null 不计入）
    prisma.purchaseOrder.aggregate({
      where: { ...where, orderDate: { gte: monthStart() } },
      _sum: { amount: true },
    }),
  ])

  // 金额脱敏（★ V3：canViewPurchaseFinanceOf 一步查部门+授权，去 OWNER/MANAGER 默认）
  const finOk = await canViewPurchaseFinanceOf(user.userId, user.role)

  const stats = {
    draft: statusGroups.find((g) => g.status === 'DRAFT')?._count._all ?? 0,
    ordered: (statusGroups.find((g) => g.status === 'ORDERED')?._count._all ?? 0),
    partial: (statusGroups.find((g) => g.status === 'PARTIAL')?._count._all ?? 0),
    inTransit: (statusGroups.find((g) => g.status === 'ORDERED')?._count._all ?? 0) +
      (statusGroups.find((g) => g.status === 'PARTIAL')?._count._all ?? 0),
    completed: statusGroups.find((g) => g.status === 'COMPLETED')?._count._all ?? 0,
    cancelled: statusGroups.find((g) => g.status === 'CANCELLED')?._count._all ?? 0,
    totalAmount: finOk
      ? statusGroups.reduce((sum, g) => sum + Number(g._sum.amount ?? 0), 0)
      : null,
    monthAmount: finOk ? Number(monthAgg._sum.amount ?? 0) : null,
  }

  // 列表行金额脱敏（★ Step3 修复 S2 评审 B1：统一走 maskPurchaseFinance，
  // 覆盖 paidAmount 等全部金额字段，不再手写 amount/settlementAmount 二元组）
  const rows = items.map((o) =>
    maskPurchaseFinance(
      {
        ...o,
        amount: o.amount != null ? Number(o.amount) : null,
        settlementAmount: o.settlementAmount != null ? Number(o.settlementAmount) : null,
        paidAmount: o.paidAmount != null ? Number(o.paidAmount) : null,
      },
      finOk,
    ),
  )

  // 含统计卡的完整响应（Step 2 遗留：stats 已计算但未返回，Step 3 前端需要）
  return ok({
    items: rows,
    pagination: {
      page,
      limit,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
    stats,
  })
})

// ───────────────────────────── POST：创建 ─────────────────────────────

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = createSchema.parse(raw)

  // 权限：采购部 / ADMIN / 项目 edit（OWNER|MANAGER）
  await assertOrderWriter(user.userId, user.role, body.projectId)

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw new ApiError(403, '项目已归档，无法创建采购订单')

  if (body.supplierId) {
    const supplier = await prisma.externalOrg.findUnique({
      where: { id: body.supplierId },
      select: { id: true, type: true },
    })
    if (!supplier || supplier.type !== 'SUPPLIER') {
      throw ApiError.badRequest('供应商不存在或类型不是 SUPPLIER')
    }
  }
  if (body.supplementaryOfId) {
    const src = await prisma.purchaseOrder.findUnique({
      where: { id: body.supplementaryOfId },
      select: { id: true, projectId: true },
    })
    if (!src || src.projectId !== body.projectId) {
      throw ApiError.badRequest('追加指向的原订单不存在或不属于该项目')
    }
  }
  if (body.isSupplementary && !body.supplementaryReason) {
    throw ApiError.badRequest('追加采购必须填写原因')
  }
  if (body.supplierRequestId) {
    const sr = await prisma.supplierRequest.findUnique({
      where: { id: body.supplierRequestId },
      select: { id: true, projectId: true, orderId: true },
    })
    if (!sr) throw ApiError.notFound('关联的采购需求不存在')
    if (sr.projectId !== body.projectId) throw ApiError.badRequest('采购需求与项目不一致')
    if (sr.orderId) throw ApiError.badRequest('该采购需求已关联订单')
  }

  // 订单总额 = 明细 sum(quantity × unitPrice)
  const amount = body.items.reduce(
    (sum, it) => sum + it.quantity * (it.unitPrice ?? 0),
    0,
  )

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 编号统一走 purchase-codes（事务内 + 并发兜底，见 Step1 评审）
    const code = await nextPurchaseOrderCode(tx, project.code)
    const order = await tx.purchaseOrder.create({
      data: {
        projectId: body.projectId,
        code,
        title: body.title,
        category: body.category ?? 'MECHANICAL',
        supplierId: body.supplierId ?? null,
        // ★ V3：订单一律 DRAFT 起步，走「发起合同→确认→正式下单」标签链（submit 参数保留兼容但不再直下）
        status: 'DRAFT',
        orderDate: body.orderDate ? new Date(body.orderDate) : null,
        plannedArrivalDate: body.plannedArrivalDate ? new Date(body.plannedArrivalDate) : null,
        amount: amount > 0 ? amount : null,
        isSupplementary: body.isSupplementary ?? false,
        supplementaryReason: body.isSupplementary ? (body.supplementaryReason ?? null) : null,
        supplementaryOfId: body.supplementaryOfId ?? null,
        ownerId: body.ownerId ?? user.userId,
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
          })),
        },
      },
      include: {
        items: true,
        supplier: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
      },
    })

    // 关联采购需求：绑定（状态留 DRAFT，后续走合同链推进）
    if (body.supplierRequestId) {
      await tx.supplierRequest.update({
        where: { id: body.supplierRequestId },
        data: { orderId: order.id },
      })
    }

    return order
  })

  return created(result, `订单 ${result.code} 已创建（草稿，请按流程推进：发起合同 → 确认 → 正式下单）`)
})
