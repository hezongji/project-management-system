import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { nextPurchaseOrderCode } from '@/lib/purchase-codes'
import { orderNotifyTargets } from '@/lib/purchase-workflow'
import { Prisma, type PurchaseCategory } from '@prisma/client'
import { z } from 'zod'

/**
 * /api/purchase-requests/ai-import —— ★ 2026-08-25 AI 工作台导入（采购模块重构）
 *
 * 用户流程：工程师乱格式清单 → AI 解析为标准表格（序号/名称/型号/参数/单位/数量/品牌/备注）
 *          → 采购员核对编辑 + 按品牌指定供应商 → 按供应商归纳 → 一键生成订单（1 供应商 1 单）
 *
 * POST { projectId, title?, rows: [{name, spec?, param?, unit, quantity, brand?, remark?, supplierId?}] }
 *
 * 事务内：
 *   1. 采购清单 PurchaseRequest（SUBMITTED → DECOMPOSED，remark 标 AI 工作台）
 *   2. 按品牌分组 → SupplierRequest（PUBLISHED，supplierId 已按工作台指定绑定）
 *   3. ★ 按供应商归纳：已指定供应商的任务 → 同一供应商合并生成 1 张 DRAFT 订单（CG-*）
 *      未指定供应商的品牌 → 任务保留 PUBLISHED 待采购后续指定（/purchase-orders/generate 补生成）
 *   4. 通知：采购部 + ADMIN + 项目全员
 */

export const dynamic = 'force-dynamic'

const rowSchema = z.object({
  name: z.string().trim().min(1, '物料名称不能为空'),
  spec: z.string().trim().optional().nullable(), // 型号
  param: z.string().trim().optional().nullable(), // 参数
  unit: z.string().trim().optional().default('件'),
  quantity: z.number().positive('数量必须大于0'),
  brand: z.string().trim().optional().nullable(),
  remark: z.string().trim().optional().nullable(),
  /** ★ 2026-08-25：Excel 单价（工作台可直接带入），透传到供应商任务报价与订单金额 */
  unitPrice: z.number().nonnegative().optional().nullable(),
  supplierId: z.string().trim().optional().nullable(), // ★ 工作台按品牌指定的供应商
})

const aiImportSchema = z.object({
  projectId: z.string().min(1, '项目不能为空'),
  title: z.string().trim().optional(),
  rows: z.array(rowSchema).min(1, '至少一行明细'),
})

const UNASSIGNED_BRAND = '待分配'
const GENERIC_BRANDS = new Set(['电气供应商', '本地', '国标', '定制', '自制', '无', '不限'])

function normalizeBrand(raw: string | null | undefined): string {
  const b = (raw ?? '').trim()
  if (!b || GENERIC_BRANDS.has(b)) return UNASSIGNED_BRAND
  return b
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = aiImportSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, name: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw new ApiError(403, '项目已归档，无法导入采购清单')

  // 供应商档案校验
  const supplierIds = Array.from(
    new Set(body.rows.map((r) => r.supplierId).filter((s): s is string => !!s)),
  )
  if (supplierIds.length > 0) {
    const orgs = await prisma.externalOrg.findMany({
      where: { id: { in: supplierIds }, type: 'SUPPLIER' },
      select: { id: true, name: true },
    })
    if (orgs.length !== supplierIds.length) {
      throw ApiError.badRequest('部分供应商不存在或类型不是 SUPPLIER，请重新选择')
    }
  }
  const orgNames = await prisma.externalOrg.findMany({
    where: { type: 'SUPPLIER' },
    select: { id: true, name: true },
  })

  // ★ 2026-08-25 修复：并发导入可能生成重复编号（PR/SR/CG code 为应用层生成，findFirst 取号存在竞态）
  //   → P2002（唯一约束冲突）时整体重试一次；仍失败则抛出明确错误，不让前端看到裸 500
  const importTx = () =>
    prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
      // ── 1. 采购清单 ──
      const prefix = `PR-${project.code}-`
      const last = await tx.purchaseRequest.findFirst({
        where: { code: { startsWith: prefix } },
        orderBy: { code: 'desc' },
        select: { code: true },
      })
      const seq = last ? parseInt(last.code.slice(prefix.length), 10) + 1 : 1
      const prCode = `${prefix}${String(seq).padStart(3, '0')}`
      const now = new Date()
      const title =
        body.title || `${project.code}-AI解析清单（${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}）`

      const pr = await tx.purchaseRequest.create({
        data: {
          projectId: project.id,
          code: prCode,
          title,
          status: 'DECOMPOSED',
          priority: 'NORMAL',
          category: 'OTHER',
          requesterId: user.userId,
          handlerId: user.userId,
          remark: 'AI 工作台导入（乱格式清单智能解析 → 品牌归纳 → 供应商归单）',
          items: {
            create: body.rows.map((r) => ({
              name: r.name,
              // ★ 2026-08-25 字段统一：spec=型号、param=参数 分列存（不再拼入 spec），全路径一致便于合并汇总
              spec: r.spec ?? null,
              param: r.param ?? null,
              brand: normalizeBrand(r.brand) === UNASSIGNED_BRAND ? null : (r.brand ?? null),
              quantity: r.quantity,
              unit: r.unit,
              remark: r.remark ?? null,
            })),
          },
        },
        include: { items: true },
      })

      // ── 2. 按品牌分组 → SupplierRequest（组内合并同类项）──
      interface GroupRow {
        rowIdx: number
        itemId: string
      }
      const groups = new Map<string, GroupRow[]>()
      body.rows.forEach((r, idx) => {
        const brand = normalizeBrand(r.brand)
        const arr = groups.get(brand) ?? []
        arr.push({ rowIdx: idx, itemId: pr.items[idx]!.id })
        groups.set(brand, arr)
      })

      // 品牌组 → 供应商映射（以组内第一行指定为准；同名供应商档案兜底匹配品牌名）
      const supplierByBrand = new Map<string, string | null>()
      for (const [brand, rowsInGroup] of Array.from(groups.entries())) {
        let sid: string | null = null
        for (const { rowIdx } of rowsInGroup) {
          const s = body.rows[rowIdx]!.supplierId
          if (s) {
            sid = s
            break
          }
        }
        if (!sid && brand !== UNASSIGNED_BRAND) {
          sid = orgNames.find((o) => o.name.includes(brand) || brand.includes(o.name))?.id ?? null
        }
        supplierByBrand.set(brand, sid)
      }

      const srCreated: Array<{ id: string; code: string; brand: string; supplierId: string | null; itemCount: number }> = []
      for (const [brand, rowsInGroup] of Array.from(groups.entries())) {
        const srPrefix = `SR-${project.code}-`
        const lastSr = await tx.supplierRequest.findFirst({
          where: { code: { startsWith: srPrefix } },
          orderBy: { code: 'desc' },
          select: { code: true },
        })
        const srSeq = lastSr ? parseInt(lastSr.code.slice(srPrefix.length), 10) + 1 : 1
        const srCode = `${srPrefix}${String(srSeq).padStart(3, '0')}`

        // 组内合并同类项（name+spec+param 相同 → 数量累加）
        const merged = new Map<
          string,
          {
            name: string
            spec: string | null
            param: string | null
            quantity: number
            unit: string
            remark: string | null
            /** ★ Excel 单价：同类项合并时按总量摊薄（unitPrice×总数量=已知金额小计，避免无价行被均价估算推高订单额）；无价则 null */
            unitPrice: number | null
            qtyPriced: number
            amountPriced: number
            sourceIds: string[]
          }
        >()
        rowsInGroup.forEach(({ rowIdx, itemId }) => {
          const r = body.rows[rowIdx]!
          const key = `${r.name}|${r.spec ?? ''}|${r.param ?? ''}`
          const cur = merged.get(key) ?? {
            name: r.name,
            spec: r.spec ?? null,
            param: r.param ?? null,
            quantity: 0,
            unit: r.unit,
            remark: r.remark ?? null,
            unitPrice: null,
            qtyPriced: 0,
            amountPriced: 0,
            sourceIds: [],
          }
          cur.quantity += r.quantity
          if (r.unitPrice != null) {
            cur.qtyPriced += r.quantity
            cur.amountPriced += r.quantity * r.unitPrice
          }
          if (!cur.remark && r.remark) cur.remark = r.remark
          cur.sourceIds.push(itemId)
          merged.set(key, cur)
        })

        const catCounts = new Map<string, number>()
        void catCounts
        const sr = await tx.supplierRequest.create({
          data: {
            projectId: project.id,
            code: srCode,
            requestId: pr.id,
            brand: brand === UNASSIGNED_BRAND ? null : brand,
            supplierId: supplierByBrand.get(brand) ?? null,
            title: `${brand === UNASSIGNED_BRAND ? '待分配' : brand} 品牌采购任务`,
            category: 'OTHER' as PurchaseCategory,
            status: 'PUBLISHED',
            creatorId: user.userId,
            items: {
              create: Array.from(merged.values()).map((m) => ({
                name: m.name,
                spec: m.spec,
                param: m.param,
                brand: brand === UNASSIGNED_BRAND ? null : brand,
                quantity: m.quantity,
                unit: m.unit,
                unitPrice:
                  m.qtyPriced > 0 && m.quantity > 0
                    ? Math.round((m.amountPriced / m.quantity) * 100) / 100
                    : null,
                remark: m.remark,
                sourceRequestItemIds: m.sourceIds,
              })),
            },
          },
          select: { id: true, code: true, _count: { select: { items: true } } },
        })
        srCreated.push({
          id: sr.id,
          code: sr.code,
          brand,
          supplierId: supplierByBrand.get(brand) ?? null,
          itemCount: sr._count.items,
        })

        // 回写 allocatedQty
        for (const { itemId } of rowsInGroup) {
          const row = body.rows.find((_, i) => pr.items[i]?.id === itemId)
          if (row) {
            await tx.purchaseRequestItem.update({
              where: { id: itemId },
              data: { allocatedQty: { increment: row.quantity } },
            })
          }
        }
      }

      // ── 3. ★ 按供应商归单：同供应商的任务合并 1 张 DRAFT 订单 ──
      const orders: Array<{ id: string; code: string; supplierName: string; itemCount: number; brands: string[] }> = []
      const toOrder = srCreated.filter((s) => s.supplierId)
      const bySupplier = new Map<string, typeof toOrder>()
      for (const sr of toOrder) {
        const arr = bySupplier.get(sr.supplierId!) ?? []
        arr.push(sr)
        bySupplier.set(sr.supplierId!, arr)
      }
      const supplierNameById = new Map(orgNames.map((o) => [o.id, o.name]))

      for (const [supplierId, group] of Array.from(bySupplier.entries())) {
        const fullSrs = await tx.supplierRequest.findMany({
          where: { id: { in: group.map((g) => g.id) } },
          include: { items: { orderBy: { name: 'asc' } } },
          orderBy: { code: 'asc' },
        })
        const allItems = fullSrs.flatMap((s) => s.items)
        const amount = allItems.reduce(
          (s, it) => s + (it.unitPrice != null ? Number(it.unitPrice) * Number(it.quantity) : 0),
          0,
        )
        const brands = Array.from(new Set(fullSrs.map((s) => s.brand).filter((b): b is string => !!b)))
        const code = await nextPurchaseOrderCode(tx, project.code)
        const order = await tx.purchaseOrder.create({
          data: {
            projectId: project.id,
            code,
            title:
              brands.length > 0
                ? `${supplierNameById.get(supplierId) ?? ''}采购订单（${brands.join('、')}）`.slice(0, 120)
                : `${supplierNameById.get(supplierId) ?? '供应商'}采购订单`,
            category: 'OTHER',
            supplierId,
            status: 'DRAFT',
            amount: amount > 0 ? amount : null,
            ownerId: user.userId,
            creatorId: user.userId,
            remark: `AI 工作台归单生成（来源任务：${fullSrs.map((s) => s.code).join('、')}）`,
            items: {
              create: allItems.map((it) => ({
                name: it.name,
                // ★ 字段统一：param 分列存（PurchaseOrderItem 已加列）
                spec: it.spec ?? null,
                param: it.param ?? null,
                brand: it.brand,
                quantity: it.quantity,
                unit: it.unit,
                unitPrice: it.unitPrice,
                remark: it.remark,
              })),
            },
          },
          select: { id: true, code: true },
        })
        for (const s of fullSrs) {
          await tx.supplierRequest.update({
            where: { id: s.id },
            data: { orderId: order.id, status: 'ORDERED' },
          })
        }
        orders.push({
          id: order.id,
          code: order.code,
          supplierName: supplierNameById.get(supplierId) ?? '',
          itemCount: allItems.length,
          brands,
        })
      }

      // ── 4. 通知：采购部 + ADMIN + 项目全员（AI 导入完成，N 张订单已生成）──
      const purchaseUsers = await tx.user.findMany({
        where: { isActive: true, department: { name: { contains: '采购' } } },
        select: { id: true },
      })
      const targets = await orderNotifyTargets(tx, orders[0]?.id ?? '', project.id)
      purchaseUsers.forEach((u) => targets.add(u.id))
      targets.delete(user.userId)
      const pendingBrands = srCreated.filter((s) => !s.supplierId).map((s) => s.brand)
      const nTitle = `AI 清单已导入：${prCode}`
      const nBody =
        orders.length > 0
          ? `「${title}」${body.rows.length} 行明细已按品牌分解，${orders.length} 张采购订单已生成` +
            (pendingBrands.length ? `；${pendingBrands.join('、')} 待指定供应商` : '')
          : `「${title}」${body.rows.length} 行明细已按品牌分解为 ${srCreated.length} 个任务，待指定供应商后生成订单`
      for (const uid of Array.from(targets)) {
        await tx.notification.create({
          data: { userId: uid, type: 'PURCHASE_REQUEST_SUBMITTED', title: nTitle, body: nBody, link: `/purchase?requestId=${pr.id}` },
        })
        await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
          event: 'notify:push',
          userId: uid,
          title: nTitle,
          body: nBody,
          link: `/purchase?requestId=${pr.id}`,
        })})`
      }

      return {
        request: { id: pr.id, code: prCode, title, itemCount: body.rows.length },
        orders,
        pendingSrs: srCreated
          .filter((s) => !s.supplierId)
          .map((s) => ({ id: s.id, code: s.code, brand: s.brand, itemCount: s.itemCount })),
        srs: srCreated,
      }
    },
    { timeout: 60_000 },
  )

  let result
  try {
    result = await importTx()
  } catch (err) {
    // 并发导入编号冲突（P2002）→ 重试一次
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      try {
        result = await importTx()
      } catch (err2) {
        if (err2 instanceof Prisma.PrismaClientKnownRequestError && err2.code === 'P2002') {
          throw new ApiError(409, '导入编号冲突（可能有并发导入），请稍后重试', 'CONFLICT')
        }
        throw err2
      }
    } else {
      throw err
    }
  }

  return created(
    result,
    `已导入 ${body.rows.length} 行，分解 ${result.srs.length} 个品牌任务，生成 ${result.orders.length} 张采购订单` +
      (result.pendingSrs.length ? `；${result.pendingSrs.length} 个品牌待指定供应商` : ''),
  )
})
