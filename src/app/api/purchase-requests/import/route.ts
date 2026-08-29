import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { Prisma, PurchaseCategory } from '@prisma/client'
import { apiHandler, created, requireAuth, ApiError } from '@/lib/api-helpers'
import { z } from 'zod'

/**
 * /api/purchase-requests/import —— ★ V3 Excel 清单导入 + 品牌汇总分解（2026-08-22，见 v3 方案 §5.3）
 *
 * POST { projectId, title?, rows: [{name, spec, param?, quantity, unit, brand?, price?, category?, supplierName?, remark?}] }
 *
 * 事务内：
 *   1. 创建采购清单 PurchaseRequest（含全部明细行，状态 SUBMITTED）
 *   2. ★ 品牌为主键分组（硬性要求 A）：同品牌器件汇总到一起
 *      - brand 非空 → 每品牌一组生成 SupplierRequest（品牌采购任务，status=PUBLISHED）
 *      - brand 空/「电气供应商」「本地」→ 统一归「待分配」组（不丢明细）
 *      - 组内合并同类项：name+spec+param 相同 → quantity 累加（保持溯源）
 *   3. ★ 不再自动下单（v2 偏离纠正）：订单留到「合同确认后」由采购点「正式下单」推进生成
 *   4. 供应商辅助建议：Excel 供应商列/品牌名精确+模糊匹配档案 → 命中则绑定 supplierId（可后续改）
 *   5. 通知采购部（PURCHASE_REQUEST_SUBMITTED）
 *
 * 返回 { request, supplierRequests: [{code, brand, itemCount, supplierName}], unmatched }
 */

const importSchema = z.object({
  projectId: z.string().min(1, '项目不能为空'),
  title: z.string().trim().optional(),
  rows: z
    .array(
      z.object({
        name: z.string().trim().min(1, '物料名称不能为空'),
        spec: z.string().trim().optional(), // 规格型号
        param: z.string().trim().optional(), // ★ V3：参数（3P 250A 50KA）
        quantity: z.number().positive('数量必须大于0'),
        unit: z.string().trim().optional().default('件'),
        brand: z.string().trim().optional().nullable(),
        price: z.number().nonnegative().optional().nullable(), // 单价（可空）
        category: z.enum(['MECHANICAL', 'ELECTRICAL', 'OTHER']).optional(),
        supplierName: z.string().trim().optional().nullable(),
        remark: z.string().trim().optional(),
      }),
    )
    .min(1, '至少一行明细'),
})

/** 待分配虚拟品牌标记（品牌空或泛称时归组用） */
const UNASSIGNED_BRAND_LABEL = '待分配'
/** 泛称品牌（不算真品牌，归待分配组） */
const GENERIC_BRANDS = new Set(['电气供应商', '本地', '国标', '定制', '自制'])

function normalizeBrand(raw: string | null | undefined): string {
  const b = (raw ?? '').trim()
  if (!b || GENERIC_BRANDS.has(b)) return UNASSIGNED_BRAND_LABEL
  return b
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = importSchema.parse(raw)

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    select: { id: true, code: true, isArchived: true },
  })
  if (!project) throw ApiError.notFound('项目不存在')
  if (project.isArchived) throw new ApiError(403, '项目已归档，无法导入采购清单')

  // 供应商档案（供辅助建议匹配；匹配不到不阻塞，任务留待分配）
  const orgs = await prisma.externalOrg.findMany({
    where: { type: 'SUPPLIER' },
    select: { id: true, name: true },
  })
  const orgByName = new Map(orgs.map((o) => [o.name, o.id]))
  function suggestSupplierId(hint: string): string | null {
    const exact = orgByName.get(hint)
    if (exact) return exact
    const hit = orgs.find((o) => o.name.includes(hint) || hint.includes(o.name))
    return hit?.id ?? null
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. 采购清单
    const prefix = `PR-${project.code}-`
    const last = await tx.purchaseRequest.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    })
    const seq = last ? parseInt(last.code.slice(prefix.length), 10) + 1 : 1
    const code = `${prefix}${String(seq).padStart(3, '0')}`

    const title =
      body.title || `${project.code}-Excel导入清单（${new Date().toISOString().slice(0, 10)}）`
    const mainCategory = (body.rows.find((r) => r.category)?.category ?? 'OTHER') as PurchaseCategory

    const request = await tx.purchaseRequest.create({
      data: {
        projectId: body.projectId,
        code,
        title,
        status: 'SUBMITTED',
        priority: 'NORMAL',
        category: mainCategory,
        requesterId: user.userId,
        remark: 'Excel 批量导入（V3 品牌汇总）',
        items: {
          create: body.rows.map((r) => ({
            name: r.name,
            spec: r.spec ?? null,
            param: r.param ?? null,
            brand: r.brand ?? null,
            quantity: r.quantity,
            unit: r.unit,
            // ★ 2026-08-25：期望价（targetPrice）已全链路下线，不再落库；price 入参保留兼容但忽略
            remark: r.remark ?? null,
          })),
        },
      },
      include: { items: true },
    })

    // 2. ★ 品牌为主键分组（方案 §5.3）+ 组内合并同类项
    const groups = new Map<
      string, // brand（归一后）
      Array<{ rowIdx: number; itemId: string }>
    >()
    body.rows.forEach((r, idx) => {
      const brand = normalizeBrand(r.brand)
      const arr = groups.get(brand) ?? []
      arr.push({ rowIdx: idx, itemId: request.items[idx].id })
      groups.set(brand, arr)
    })

    // 供应商建议（优先用 Excel 供应商列，其次品牌名当 hint）
    const supplierByBrand = new Map<string, string | null>()
    for (const [brand, rowsInGroup] of Array.from(groups.entries())) {
      // 组内第一行的 supplierName 优先；否则用品牌名匹配（SCHNEIDER→施耐德经销商等）
      let hint = ''
      for (const { rowIdx } of rowsInGroup) {
        const sn = body.rows[rowIdx].supplierName
        if (sn && sn.trim()) {
          hint = sn.trim()
          break
        }
      }
      if (!hint && brand !== UNASSIGNED_BRAND_LABEL) hint = brand
      supplierByBrand.set(brand, hint ? suggestSupplierId(hint) : null)
    }

    // 3. 每品牌组 → 1 张 SupplierRequest（PUBLISHED 待采购处理），不生成订单
    const srResults: Array<{ id: string; code: string; brand: string; itemCount: number; supplierName: string | null; title: string | null }> = []
    for (const [brand, rowsInGroup] of Array.from(groups.entries())) {
      const srPrefix = `SR-${project.code}-`
      const lastSr = await tx.supplierRequest.findFirst({
        where: { code: { startsWith: srPrefix } },
        orderBy: { code: 'desc' },
        select: { code: true },
      })
      const srSeq = lastSr ? parseInt(lastSr.code.slice(srPrefix.length), 10) + 1 : 1
      const srCode = `${srPrefix}${String(srSeq).padStart(3, '0')}`

      // 组内类别取多数；标题用品牌
      const catCounts = new Map<string, number>()
      rowsInGroup.forEach(({ rowIdx }) => {
        const c = body.rows[rowIdx].category ?? 'OTHER'
        catCounts.set(c, (catCounts.get(c) ?? 0) + 1)
      })
      const groupCategory = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1])[0][0] as PurchaseCategory

      // ★ 组内合并同类项（name+spec+param 相同 → quantity 累加，方案 §5.3 第3条）
      const merged = new Map<
        string, // `${name}|${spec}|${param}`
        { name: string; spec: string | null; param: string | null; quantity: number; unit: string; price: number | null; remark: string | null; sourceItemIds: string[] }
      >()
      rowsInGroup.forEach(({ rowIdx, itemId }) => {
        const r = body.rows[rowIdx]
        const key = `${r.name}|${r.spec ?? ''}|${r.param ?? ''}`
        const cur = merged.get(key) ?? {
          name: r.name,
          spec: r.spec ?? null,
          param: r.param ?? null,
          quantity: 0,
          unit: r.unit,
          price: r.price ?? null,
          remark: r.remark ?? null,
          sourceItemIds: [],
        }
        cur.quantity += r.quantity
        if (cur.price == null && r.price != null) cur.price = r.price
        cur.sourceItemIds.push(itemId)
        merged.set(key, cur)
      })

      const suggestedSupplierId = supplierByBrand.get(brand) ?? null
      const sr = await tx.supplierRequest.create({
        data: {
          projectId: body.projectId,
          code: srCode,
          requestId: request.id,
          brand: brand === UNASSIGNED_BRAND_LABEL ? null : brand,
          supplierId: suggestedSupplierId, // ★ 辅助建议绑定（可后续改）
          title: `${brand === UNASSIGNED_BRAND_LABEL ? '待分配' : brand} 品牌采购任务`,
          category: groupCategory,
          status: 'PUBLISHED', // ★ 已发布待采购处理（v3：不自动下单）
          creatorId: user.userId,
          items: {
            create: Array.from(merged.values()).map((m) => ({
              name: m.name,
              spec: m.spec,
              param: m.param,
              brand: brand === UNASSIGNED_BRAND_LABEL ? null : brand,
              quantity: m.quantity,
              unit: m.unit,
              unitPrice: m.price,
              remark: m.remark,
              sourceRequestItemIds: m.sourceItemIds,
            })),
          },
        },
        select: { id: true, code: true, title: true, _count: { select: { items: true } }, supplier: { select: { name: true } } },
      })
      srResults.push({
        id: sr.id,
        code: sr.code,
        brand,
        itemCount: sr._count.items,
        supplierName: sr.supplier?.name ?? null,
        title: sr.title,
      })

      // 回写 allocatedQty
      for (const { itemId } of rowsInGroup) {
        const r = body.rows.find((_, i) => request.items[i]?.id === itemId)
        if (r) {
          await tx.purchaseRequestItem.update({
            where: { id: itemId },
            data: { allocatedQty: { increment: r.quantity } },
          })
        }
      }
    }

    // 清单置 DECOMPOSED + handler
    if (srResults.length > 0) {
      await tx.purchaseRequest.update({
        where: { id: request.id },
        data: { status: 'DECOMPOSED', handlerId: user.userId },
      })
    }

    // ★ 通知采购部（PURCHASE_REQUEST_SUBMITTED + 待办）
    const purchaseUsers = await tx.user.findMany({
      where: { isActive: true, department: { name: { contains: '采购' } } },
      select: { id: true },
    })
    const admins = await tx.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
    const notifyTargets = new Set<string>()
    purchaseUsers.forEach((u) => notifyTargets.add(u.id))
    admins.forEach((u) => notifyTargets.add(u.id))
    for (const uid of Array.from(notifyTargets)) {
      await tx.notification.create({
        data: {
          userId: uid,
          type: 'PURCHASE_REQUEST_SUBMITTED',
          title: `新采购清单：${code}`,
          body: `${title}（${body.rows.length} 行，已按 ${srResults.length} 个品牌分解）`,
          link: `/purchase?requestId=${request.id}`,
        },
      })
      await tx.todoItem.create({
        data: {
          userId: uid,
          title: `处理采购清单：${code}`,
          sourceType: 'PURCHASE_REQUEST',
          sourceId: request.id,
          link: `/purchase?requestId=${request.id}`,
          priority: 'MEDIUM',
        },
      })
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'notify:push',
        userId: uid,
        title: `新采购清单：${code}`,
        body: `${title}（${body.rows.length} 行，${srResults.length} 个品牌任务待处理）`,
        link: `/purchase?requestId=${request.id}`,
      })})`
    }

    return { request, srResults }
  })

  return created(
    {
      request: {
        id: result.request.id,
        code: result.request.code,
        title: result.request.title,
        itemCount: result.request.items.length,
      },
      supplierRequests: result.srResults,
    },
    `已导入 ${body.rows.length} 行，按品牌分解为 ${result.srResults.length} 张采购任务（订单将在合同确认后生成）`,
  )
})
