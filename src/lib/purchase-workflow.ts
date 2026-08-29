/**
 * 采购工作流引擎（★ V3 2026-08-22，见设计方案-采购管理-v3 §三）
 *
 * 订单状态标签链（用户可点选）：
 *   DRAFT → CONTRACT_PENDING → CONFIRMED → ORDERED → PREPARING → SHIPPED → PARTIAL → COMPLETED
 *   任意非终态 → CANCELLED
 *
 * 付款/收货进度作派生副标签（paidAmount 三态、收货行进度），不塞主状态机。
 */

import { prisma } from '@/lib/prisma'
import { getUserDeptName, isPurchaseDept } from '@/lib/data-visibility'
import type { Prisma, PurchaseOrderStatus } from '@prisma/client'

/** ★ 状态转换白名单（方案 §3.4，代码常量不引工作流引擎） */
export const ORDER_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ['CONTRACT_PENDING', 'CANCELLED'],
  CONTRACT_PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['PARTIAL', 'CANCELLED'],
  PARTIAL: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
}

/** 状态显示元数据（前端标签条用，后端校验参考） */
export const ORDER_STATUS_META: Record<PurchaseOrderStatus, { label: string; order: number }> = {
  DRAFT: { label: '草稿', order: 0 },
  CONTRACT_PENDING: { label: '待合同', order: 1 },
  CONFIRMED: { label: '合同已确认', order: 2 },
  ORDERED: { label: '已下单·待付款', order: 3 },
  PREPARING: { label: '已付款·备货中', order: 4 },
  SHIPPED: { label: '已发货', order: 5 },
  PARTIAL: { label: '部分到货', order: 6 },
  COMPLETED: { label: '已完成', order: 7 },
  CANCELLED: { label: '已取消', order: -1 },
}

/** 推进动作定义：action → { to, label, allowedRoles } */
export const ADVANCE_ACTIONS: Record<
  string,
  { to: PurchaseOrderStatus; label: string; actor: 'PURCHASE' | 'PURCHASE_OR_FINANCE' | 'PURCHASE_OR_ADMIN' }
> = {
  START_CONTRACT: { to: 'CONTRACT_PENDING', label: '发起合同', actor: 'PURCHASE' },
  CONFIRM_CONTRACT: { to: 'CONFIRMED', label: '确认合同与价格', actor: 'PURCHASE' },
  PLACE_ORDER: { to: 'ORDERED', label: '正式下单', actor: 'PURCHASE' },
  MARK_PREPARING: { to: 'PREPARING', label: '登记付款·备货中', actor: 'PURCHASE_OR_FINANCE' },
  MARK_SHIPPED: { to: 'SHIPPED', label: '登记发货', actor: 'PURCHASE' },
  CANCEL: { to: 'CANCELLED', label: '取消/作废', actor: 'PURCHASE_OR_ADMIN' },
}

/** 校验操作者是否有权执行该 action */
export async function canAdvance(
  userId: string,
  role: string,
  action: keyof typeof ADVANCE_ACTIONS,
): Promise<boolean> {
  const def = ADVANCE_ACTIONS[action]
  if (!def) return false
  if (role === 'ADMIN') return true
  const deptName = await getUserDeptName(userId)
  const isFinance = !!deptName && deptName.includes('财务')
  const isPurchase = isPurchaseDept(deptName)
  switch (def.actor) {
    case 'PURCHASE':
      return isPurchase
    case 'PURCHASE_OR_FINANCE':
      return isPurchase || isFinance
    case 'PURCHASE_OR_ADMIN':
      return isPurchase
    default:
      return false
  }
}

/**
 * ★ 状态推进通知（事务内调用）：通知「清单发布人」+ 相关收货人
 * pg_notify im_events + Notification + TodoItem（幂等）
 */
export async function notifyOrderAdvanced(
  tx: Prisma.TransactionClient,
  order: { id: string; code: string; title: string; projectId: string },
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
  extra?: { receiverId?: string | null },
): Promise<void> {
  const fromLabel = ORDER_STATUS_META[from]?.label ?? from
  const toLabel = ORDER_STATUS_META[to]?.label ?? to
  const title = `采购进度：${order.code} ${toLabel}`
  const body = `「${order.title}」状态已从「${fromLabel}」推进为「${toLabel}」`
  const link = `/purchase?orderId=${order.id}`

  // 收集通知对象：清单发布人（requester）∪ 订单指派收货人
  const targets = new Set<string>()
  // 溯源：订单 ← SupplierRequest ← PurchaseRequest(requester)
  const sr = await tx.supplierRequest.findUnique({
    where: { orderId: order.id },
    select: { requestId: true, request: { select: { requesterId: true } } },
  })
  if (sr?.request?.requesterId) targets.add(sr.request.requesterId)
  if (extra?.receiverId) targets.add(extra.receiverId)
  // ADMIN 也收一份进度通知（总览）
  const admins = await tx.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
  admins.forEach((a) => targets.add(a.id))

  for (const userId of Array.from(targets)) {
    await tx.notification.create({
      data: { userId, type: 'PURCHASE_STATUS_CHANGED', title, body, link },
    })
    await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
      event: 'notify:push',
      userId,
      title,
      body,
      link,
    })})`
  }
}

/**
 * 事务内重算订单付款总额（paidAmount 冗余回写）
 */
export async function recalcPaidAmount(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const payments = await tx.purchasePayment.findMany({
    where: { orderId, status: 'PAID' },
    select: { type: true, amount: true },
  })
  const paid = payments.reduce((s, p) => {
    // REFUND 记负向冲减
    return p.type === 'REFUND' ? s - Number(p.amount) : s + Number(p.amount)
  }, 0)
  await tx.purchaseOrder.update({
    where: { id: orderId },
    data: { paidAmount: paid },
  })
  return paid
}
