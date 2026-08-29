/**
 * 采购编号规则（设计方案 §3.7 / MVP 开发计划 Step 1）
 *
 *   订单编号   CG-{项目编号}-{3位流水}   如 CG-DEMO26001-001
 *   到货批次号 {订单号}-{序号}           如 CG-DEMO26001-001-1
 *             （可手动改为供应商送货单号，默认自动生成）
 *
 * 约定：
 * - 订单流水在「项目内」递增：同一 projectId 下取 CG-{code}- 前缀最大流水 +1，
 *   追加单与常规单共用流水（用 isSupplementary 区分，不另编号段）
 * - 越过 999 自然扩位（padStart 不截断）
 * - 均在事务客户端内执行，与 nextProjectCode 相同的「已占用则继续 +1」兜底
 */

import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/** 订单编号前缀：CG-{项目编号}- */
export function purchaseOrderCodePrefix(projectCode: string): string {
  return `CG-${projectCode}-`
}

/**
 * 生成下一个采购订单编号：CG-{项目编号}-{3位流水}。
 * @param tx           事务客户端（可直接传 prisma 单客户端）
 * @param projectCode  项目编号（如 DEMO26001）
 */
export async function nextPurchaseOrderCode(
  tx: Tx,
  projectCode: string,
): Promise<string> {
  const prefix = purchaseOrderCodePrefix(projectCode)
  // 只扫该项目编号段的订单（跨项目同名前缀天然隔离）
  const existing = await tx.purchaseOrder.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  })
  let max = 0
  const pattern = new RegExp(`^${escapeRe(prefix)}(\\d+)$`)
  for (const o of existing) {
    const m = pattern.exec(o.code)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  let seq = max + 1
  for (let i = 0; i < 1000; i++, seq++) {
    const code = `${prefix}${String(seq).padStart(3, '0')}`
    const taken = await tx.purchaseOrder.findUnique({ where: { code } })
    if (!taken) return code
  }
  throw new Error(`采购订单编号已用尽（${prefix} 段）`)
}

/**
 * 生成下一个到货批次号：{订单号}-{序号}（序号 1 起）。
 * 因批次号允许手动改为供应商送货单号，序号取「该订单已登记到货次数」与
 * 「仍为默认格式批次中的最大序号」的较大者 +1，保证不回退不复用。
 * @param tx         事务客户端
 * @param orderId    订单 id（用于计数；批次号前缀取订单 code）
 * @param orderCode  订单编号（如 CG-DEMO26001-001）
 */
export async function nextArrivalBatchNo(
  tx: Tx,
  orderId: string,
  orderCode: string,
): Promise<string> {
  const prefix = `${orderCode}-`
  const arrivals = await tx.goodsArrival.findMany({
    where: { orderId },
    select: { batchNo: true },
  })
  let max = 0
  const pattern = new RegExp(`^${escapeRe(prefix)}(\\d+)$`)
  for (const a of arrivals) {
    const m = pattern.exec(a.batchNo)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  const count = arrivals.length
  const seq = Math.max(max, count) + 1
  return `${prefix}${seq}`
}

/** 正则转义（前缀里的 - 等字符按字面量处理） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
