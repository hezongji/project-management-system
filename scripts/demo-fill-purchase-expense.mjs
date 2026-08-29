/**
 * demo-fill-purchase-expense.mjs —— 采购全链路 + 费用报销 审批流演示数据填充
 *
 * 前置：已跑过 `npm run db:seed` + `npm run db:seed-demo`（51 用户/项目/成员/费用分类字典就位）。
 * 运行：node scripts/demo-fill-purchase-expense.mjs （项目根目录，读 .env 的 DATABASE_URL）
 *
 * 覆盖范围（状态谱全覆盖，链路语义自洽）：
 *   采购清单 PurchaseRequest：DRAFT/SUBMITTED/PROCESSING/DECOMPOSED/COMPLETED/REJECTED（15 张）
 *   采购需求 SupplierRequest：DRAFT/PUBLISHED/QUOTED×2/ORDERED×2/CANCELLED（7 张，状态谱全覆盖）
 *   采购订单 PurchaseOrder：DRAFT/ORDERED/CONTRACT_PENDING/CONFIRMED/PREPARING/SHIPPED/PARTIAL/COMPLETED×3(含追加单)/CANCELLED（10 张）
 *   采购合同 PurchaseContract：PENDING/CONFIRMED/VOIDED（9 张）
 *   付款流水 PurchasePayment：PREPAYMENT/FULL/TAIL/REFUND × PLANNED/PAID（13 笔，金额加总≈订单额）
 *   到货清点 GoodsArrival：PENDING/RECEIVED/PARTIAL/REJECTED（8 批，一单多批含部分到货）
 *   费用报销 ExpenseClaim：DRAFT/SUBMITTED/APPROVED/REJECTED/PAID（30 张，1-5 明细/张）
 *
 * 幂等：本脚本产生的全部数据 remark 含标记 demo-fill-purchase-expense，重跑先按依赖顺序清理。
 * 确定性：mulberry32+hashStr（与 prisma/seed-demo-data.ts 同款），重跑结果一致。
 * 只写采购/费用表；User/Project/ExternalOrg/ExpenseCategory 等只读选 id。
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'

// ───────────────────────────── .env 加载（零依赖，仅取 DATABASE_URL）─────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    const envText = readFileSync(join(process.cwd(), '.env'), 'utf8')
    const m = envText.match(/^DATABASE_URL\s*=\s*(.+)$/m)
    if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* .env 缺失则依赖环境变量 */ }
}

const prisma = new PrismaClient()

const MARK = 'demo-fill-purchase-expense'
const T0 = new Date('2025-09-08') // 与 seed-demo-data.ts 台账冻结基准一致

// ───────────────────────────── 工具 ─────────────────────────────
function hashStr(s) {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const addDays = (d, n) => new Date(d.getTime() + n * 24 * 3600 * 1000)
const d2 = (n) => Number(n).toFixed(2) // Decimal 字符串（两位小数）
/** rng 从区间取整数 */
const pickInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
const pickOne = (rng, arr) => arr[Math.floor(rng() * arr.length)]

// ───────────────────────────── 字典（全部虚构，无真实品牌/客户）─────────────────────────────
// 材料：{name, specs[], brands[](null=不限品牌), unit, priceLo, priceHi, category}
const MATERIALS = [
  { name: '交流伺服电机', specs: ['750W 带刹车', '1.5KW 不带刹车', '2.3KW 带刹车'], brands: ['华驱', '锐立'], unit: '台', priceLo: 2800, priceHi: 6800, category: 'ELECTRICAL' },
  { name: 'PLC 控制模块', specs: ['16 点 DI', '32 点 DO', '模拟量 4AI/2AO'], brands: ['澜控', '九方'], unit: '个', priceLo: 1200, priceHi: 5500, category: 'ELECTRICAL' },
  { name: '变频器', specs: ['5.5KW 三相 380V', '11KW 三相 380V'], brands: ['澜控'], unit: '台', priceLo: 2200, priceHi: 4800, category: 'ELECTRICAL' },
  { name: '低压断路器', specs: ['3P 250A 50KA', '2P 63A C型'], brands: ['欧谟'], unit: '个', priceLo: 180, priceHi: 900, category: 'ELECTRICAL' },
  { name: '屏蔽控制电缆', specs: ['RVVP 4×1.5', 'RVVP 8×1.0'], brands: [null], unit: '米', priceLo: 8, priceHi: 25, category: 'ELECTRICAL' },
  { name: '工业触摸屏', specs: ['10.1 寸', '7 寸'], brands: ['华驱'], unit: '台', priceLo: 1800, priceHi: 3600, category: 'ELECTRICAL' },
  { name: '气动电磁阀', specs: ['二位五通 24VDC', '二位三通 24VDC'], brands: ['欧谟'], unit: '个', priceLo: 220, priceHi: 560, category: 'ELECTRICAL' },
  { name: '不锈钢球阀', specs: ['DN50 PN16', 'DN25 PN16'], brands: ['晟泰'], unit: '个', priceLo: 120, priceHi: 480, category: 'MECHANICAL' },
  { name: '不锈钢卫生管件', specs: ['DN40 三通', 'DN40 弯头 90°'], brands: ['晟泰'], unit: '件', priceLo: 60, priceHi: 260, category: 'MECHANICAL' },
  { name: 'PVC 输送带', specs: ['宽 800mm 厚 3mm', '宽 600mm 厚 2mm'], brands: ['九方'], unit: '米', priceLo: 320, priceHi: 780, category: 'MECHANICAL' },
  { name: '深沟球轴承', specs: ['6208-2Z', '6305-2Z'], brands: ['锐立'], unit: '套', priceLo: 45, priceHi: 180, category: 'MECHANICAL' },
  { name: '铝型材支架', specs: ['4040 阳极氧化', '3030 阳极氧化'], brands: [null], unit: '根', priceLo: 35, priceHi: 95, category: 'MECHANICAL' },
  { name: '机柜冷风机', specs: ['AC 220V 550W'], brands: ['宏远'], unit: '台', priceLo: 600, priceHi: 1200, category: 'OTHER' },
  { name: '聚氨酯密封胶', specs: ['50ml/支'], brands: [null], unit: '支', priceLo: 18, priceHi: 45, category: 'OTHER' },
]
const PR_TITLES = ['电气元件一批', '管路阀门补货', '现场加急辅材', '电柜制作元器件', '机械结构件加工配套', '现场安装缺件补充', '输送线易损件备件', '仪表传感元件一批']
const PR_PURPOSES = ['电柜制作工序使用', '现场安装缺件补充', '产线调试备件准备', '设计变更后物料补差', '二期扩容预留物料']
const REJECT_REASONS_PR = ['预算超标，请拆分为两批后重新提交', '部分物料与库存重复，核减后重提', '技术参数不明确，请工艺确认后再提']
const REJECT_REASONS_CLAIM = ['发票抬头有误，请更换后重新提交', '缺少行程审批单，补附件后重提', '金额与申报标准不符，请核对差旅制度']
const SUPPLEMENT_REASONS = ['现场缺件加急补充', '设计变更追加', '损耗补充']
const PAY_METHODS = ['银行转账', '承兑汇票', '银行转账', '银行转账']
const EXPENSE_DESCS = {
  TRIP: ['项目现场出差高铁及住宿', '客户厂区调试驻场差旅', '跨省技术交流差旅'],
  LOGISTICS: ['发往客户现场设备物流费', '样机快递费', '紧急空运补件运费'],
  SITE_PURCHASE: ['现场临时采购紧固件', '工地临时采购辅材', '现场采购安装耗材'],
  RECEPTION: ['客户验收招待餐费', '供应商技术交流招待', '项目评审会务茶歇'],
  RENTAL: ['现场吊车租赁', '调试期仪器租赁', '临时仓库租赁'],
  REPAIR: ['现场设备维修', '测试台架维修', '气动元件更换维修'],
  TELECOM: ['项目现场宽带费', '调试人员通讯补贴'],
  OFFICE: ['项目资料打印装订', '现场办公耗材'],
  INSURANCE: ['发运设备运输保险', '现场安装工程保险'],
  INSPECTION: ['压力容器检测费', '焊缝探伤检测费', '电气安全检测费'],
  OTHER: ['项目杂项支出', '现场临时用工'],
}

// ═══════════════════════════ 幂等清理（按 FK 依赖顺序）═══════════════════════════
async function purge() {
  const f = { remark: { contains: MARK } }
  // 两步法：deleteMany 的 where 不支持关系过滤，先查父表 id 再按外键删子表
  const claimIds = (await prisma.expenseClaim.findMany({ where: f, select: { id: true } })).map((x) => x.id)
  const arrivalIds = (await prisma.goodsArrival.findMany({ where: f, select: { id: true } })).map((x) => x.id)
  const orderIds = (await prisma.purchaseOrder.findMany({ where: f, select: { id: true } })).map((x) => x.id)
  const srIds = (await prisma.supplierRequest.findMany({ where: f, select: { id: true } })).map((x) => x.id)
  const prIds = (await prisma.purchaseRequest.findMany({ where: f, select: { id: true } })).map((x) => x.id)
  const n1 = await prisma.expenseItem.deleteMany({ where: { claimId: { in: claimIds } } })
  const n2 = await prisma.expenseClaim.deleteMany({ where: f })
  const n3 = await prisma.goodsArrivalItem.deleteMany({ where: { arrivalId: { in: arrivalIds } } })
  const n4 = await prisma.goodsArrival.deleteMany({ where: f })
  const n5 = await prisma.purchasePayment.deleteMany({ where: { orderId: { in: orderIds } } })
  const n6 = await prisma.purchaseContract.deleteMany({ where: { orderId: { in: orderIds } } })
  // SupplierRequest.orderId 引用订单（1:1）：先断开再删
  await prisma.supplierRequest.updateMany({ where: { ...f, orderId: { not: null } }, data: { orderId: null } })
  const n7 = await prisma.supplierRequestItem.deleteMany({ where: { supplierRequestId: { in: srIds } } })
  const n8 = await prisma.supplierRequest.deleteMany({ where: f })
  const n9 = await prisma.purchaseOrderItem.deleteMany({ where: { orderId: { in: orderIds } } })
  const n10 = await prisma.purchaseOrder.deleteMany({ where: f })
  const n11 = await prisma.purchaseRequestItem.deleteMany({ where: { requestId: { in: prIds } } })
  const n12 = await prisma.purchaseRequest.deleteMany({ where: f })
  const total = n1.count + n2.count + n3.count + n4.count + n5.count + n6.count + n7.count + n8.count + n9.count + n10.count + n11.count + n12.count
  console.log(`[purge] 清理本脚本旧数据 ${total} 行（expenseItem ${n1.count} / claim ${n2.count} / arrivalItem ${n3.count} / arrival ${n4.count} / payment ${n5.count} / contract ${n6.count} / srItem ${n7.count} / sr ${n8.count} / orderItem ${n9.count} / order ${n10.count} / prItem ${n11.count} / pr ${n12.count}）`)
}

// ═══════════════════════════ 物料明细构造 ═══════════════════════════
/** 从材料字典确定性生成 n 条明细（含规格/品牌/单价），返回通用行 */
function makeMaterialRows(rng, n, categoryFilter) {
  const pool = categoryFilter ? MATERIALS.filter((m) => m.category === categoryFilter) : MATERIALS
  const rows = []
  const used = new Set()
  for (let i = 0; i < n; i++) {
    let mat = pickOne(rng, pool)
    let guard = 0
    while (used.has(mat.name) && guard++ < 10) mat = pickOne(rng, pool)
    used.add(mat.name)
    const spec = pickOne(rng, mat.specs)
    const brand = pickOne(rng, mat.brands)
    const qty = pickInt(rng, mat.unit === '米' ? 30 : 2, mat.unit === '米' ? 300 : 24)
    const unitPrice = pickInt(rng, mat.priceLo, mat.priceHi)
    rows.push({ name: mat.name, spec, brand, quantity: qty, unit: mat.unit, unitPrice, category: mat.category })
  }
  return rows
}

// ═══════════════════════════ 主流程 ═══════════════════════════
const stats = {
  purchaseRequest: 0, purchaseRequestItem: 0,
  supplierRequest: 0, supplierRequestItem: 0,
  purchaseOrder: 0, purchaseOrderItem: 0,
  purchaseContract: 0, purchasePayment: 0,
  goodsArrival: 0, goodsArrivalItem: 0,
  expenseClaim: 0, expenseItem: 0,
}

async function main() {
  console.log(`[demo-fill-purchase-expense] 开始，T0=${T0.toISOString().slice(0, 10)}`)
  await purge()

  // ── 0. 加载基础数据（全部真实 id）──
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true } })
  if (!admin) throw new Error('未找到 ADMIN 用户，请先跑 npm run db:seed')

  // 采购经办人：采购部成员 → 岗位含"采购" → ADMIN 兜底
  let purchasers = await prisma.user.findMany({
    where: { isActive: true, department: { name: '采购部' } },
  })
  if (purchasers.length === 0) {
    purchasers = await prisma.user.findMany({ where: { isActive: true, jobTitle: { contains: '采购' } } })
  }
  if (purchasers.length === 0) purchasers = [admin]
  const purchaser = purchasers[0]
  const purchaserB = purchasers[1 % purchasers.length] // 第二经办人（可同人）

  const suppliers = await prisma.externalOrg.findMany({ where: { type: 'SUPPLIER' } })
  if (suppliers.length === 0) throw new Error('库中无 SUPPLIER 类型供应商（ExternalOrg），请先跑 npm run db:seed')
  const expenseCats = await prisma.expenseCategory.findMany({ where: { isActive: true } })
  if (expenseCats.length === 0) throw new Error('费用分类字典为空，请先跑 npm run db:seed')
  const catByCode = new Map(expenseCats.map((c) => [c.code, c]))

  // 12 个非归档项目（确定性挑法）
  const activeProjects = await prisma.project.findMany({
    where: { isArchived: false, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
    include: { members: { include: { user: { select: { id: true, name: true } } } } },
  })
  if (activeProjects.length < 12) throw new Error(`可用 ACTIVE 项目 ${activeProjects.length} < 12`)
  const projRng = mulberry32(hashStr('dfpe-projects'))
  const shuffled = [...activeProjects]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(projRng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const P = shuffled.slice(0, 12)
  const Pm = P.map((p) => ({
    project: p,
    members: p.members.map((m) => m.user).filter(Boolean),
    rng: mulberry32(hashStr('dfpe-' + p.code)),
  }))
  const memberOf = (ctx, k = 0) =>
    ctx.members.length > 0 ? ctx.members[hashStr(ctx.project.code + k) % ctx.members.length] : { id: admin.id, name: admin.name }

  // 编号计数器（code 全局唯一）
  let seqPr = 0, seqSr = 0, seqCg = 0
  const codeOf = (prefix, p, n) => `${prefix}-${p.code}-${String(n).padStart(3, '0')}`

  // ═══════════ 1. 采购清单 PurchaseRequest（15 张，状态谱）═══════════
  // [项目索引, 状态, 链路备注]
  const PR_PLAN = [
    [0, 'COMPLETED', '链A'], [1, 'COMPLETED', '链B'], [2, 'DECOMPOSED', '链C'],
    [3, 'DECOMPOSED', ''], [4, 'DECOMPOSED', ''], [4, 'PROCESSING', ''],
    [5, 'SUBMITTED', ''], [5, 'PROCESSING', '链D'], [6, 'SUBMITTED', ''],
    [6, 'REJECTED', ''], [7, 'REJECTED', ''], [8, 'DRAFT', ''],
    [9, 'COMPLETED', '链E'], [10, 'COMPLETED', '链F'], [11, 'COMPLETED', '链G'],
  ]
  const prByTag = {} // 链路标记 → PR 记录（含 items）
  for (let planIdx = 0; planIdx < PR_PLAN.length; planIdx++) {
    const [pi, status, tag] = PR_PLAN[planIdx]
    const ctx = Pm[pi]
    const rng = mulberry32(hashStr(`dfpe-pr-${ctx.project.code}-${status}-${planIdx}`))
    const rows = makeMaterialRows(rng, pickInt(rng, 2, 4))
    const mainCat = rows[0].category
    const requester = memberOf(ctx, 1)
    seqPr++
    const isRejected = status === 'REJECTED'
    const isDraft = status === 'DRAFT'
    const handled = ['PROCESSING', 'DECOMPOSED', 'COMPLETED'].includes(status)
    const pr = await prisma.purchaseRequest.create({
      data: {
        projectId: ctx.project.id,
        code: codeOf('PR', ctx.project, seqPr),
        title: pickOne(rng, PR_TITLES),
        purpose: pickOne(rng, PR_PURPOSES),
        category: mainCat,
        status,
        priority: pickOne(rng, ['LOW', 'NORMAL', 'NORMAL', 'URGENT']),
        expectedArrivalDate: addDays(T0, pickInt(rng, 5, 30)),
        requesterId: requester.id,
        handlerId: handled ? (seqPr % 2 === 0 ? purchaser : purchaserB).id : null,
        rejectReason: isRejected ? pickOne(rng, REJECT_REASONS_PR) : null,
        remark: `${MARK} ${status} 演示`,
        createdAt: addDays(T0, -pickInt(rng, 10, 45)),
        items: {
          create: rows.map((r) => ({
            name: r.name, spec: r.spec, param: `工作电压 24VDC/防护等级 IP54（${r.spec}）`,
            brand: r.brand, quantity: d2(r.quantity), unit: r.unit,
            targetPrice: d2(r.unitPrice),
            remark: isDraft ? '待补充技术要求' : null,
            allocatedQty: ['DECOMPOSED', 'COMPLETED'].includes(status) ? d2(r.quantity) : d2(0),
          })),
        },
      },
      include: { items: true },
    })
    stats.purchaseRequest++
    stats.purchaseRequestItem += pr.items.length
    if (tag) prByTag[tag] = { pr, ctx, rng, rows }
  } // PR_PLAN 循环结束（planIdx 仅作确定性种子）

  // ═══════════ 2. 订单（10 张，9 态全覆盖）+ 合同 + 付款（先建订单，SR 的 orderId 后补）═══════════
  /** 订单构造器：返回 {order, items} */
  async function createOrder({ ctx, status, opts = {} }) {
    const rng = mulberry32(hashStr('dfpe-cg-' + ctx.project.code + status + (opts.key ?? '')))
    const cat = opts.category ?? pickOne(rng, ['ELECTRICAL', 'MECHANICAL'])
    const rows = opts.rows ?? makeMaterialRows(rng, pickInt(rng, 2, 4), cat)
    const amount = rows.reduce((s, r) => s + r.quantity * r.unitPrice, 0)
    const supplier = pickOne(rng, suppliers)
    seqCg++
    const code = codeOf('CG', ctx.project, seqCg)
    const isCancelled = status === 'CANCELLED'
    const isDraft = status === 'DRAFT'
    const pastContract = ['CONFIRMED', 'PREPARING', 'SHIPPED', 'PARTIAL', 'COMPLETED'].includes(status)
    const orderDate = addDays(T0, -pickInt(rng, 12, 35))
    const planArrival = addDays(orderDate, pickInt(rng, 15, 40))
    const shipped = status === 'SHIPPED'
    const deliveryType = pickOne(rng, ['TO_COMPANY', 'TO_COMPANY', 'TO_CUSTOMER', 'SELF_PICKUP'])
    // 累计已付（后回写，addPayments 内做增量）
    const order = await prisma.purchaseOrder.create({
      data: {
        projectId: ctx.project.id,
        code,
        category: cat,
        supplierId: isCancelled ? null : supplier.id,
        title: opts.title ?? `${cat === 'ELECTRICAL' ? '电气元件' : '机械配件'}第${seqCg}批`,
        status,
        isSupplementary: !!opts.supplementaryOfId,
        supplementaryReason: opts.supplementaryOfId ? pickOne(rng, SUPPLEMENT_REASONS) : null,
        supplementaryOfId: opts.supplementaryOfId ?? null,
        orderDate: isDraft ? null : orderDate,
        plannedArrivalDate: isDraft || isCancelled ? null : planArrival,
        amount: d2(amount),
        settlementAmount: status === 'COMPLETED' ? d2(Math.round(amount * (0.97 + rng() * 0.03))) : null,
        remark: `${MARK} ${status} 演示${opts.remarkSuffix ?? ''}`,
        ownerId: purchaser.id,
        creatorId: purchaser.id,
        deliveryType,
        deliveryAddress: deliveryType === 'TO_CUSTOMER' ? `${ctx.project.name.slice(0, 8)}项目现场（客户指定收货）` : null,
        deliveryContact: '收货组 138-0000-0000',
        receiverId: memberOf(ctx, 2).id,
        shippedAt: shipped ? addDays(orderDate, pickInt(rng, 5, 10)) : null,
        shippingNote: shipped ? `物流单号 SF${pickInt(rng, 1000000000, 9999999999)}，在途` : null,
        paidAmount: d2(0),
        items: {
          create: rows.map((r) => ({
            name: r.name, spec: r.spec, brand: r.brand,
            quantity: d2(r.quantity), unit: r.unit, unitPrice: d2(r.unitPrice),
            remark: null,
          })),
        },
      },
      include: { items: true },
    })
    stats.purchaseOrder++
    stats.purchaseOrderItem += order.items.length

    // 合同（DRAFT/ORDERED/CONTRACT_PENDING 阶段：CONTRACT_PENDING 有 PENDING 合同；DRAFT/CANCELLED 无或 VOIDED）
    if (status === 'CONTRACT_PENDING' || pastContract) {
      const confirmed = pastContract
      await prisma.purchaseContract.create({
        data: {
          orderId: order.id,
          contractNo: code,
          supplierContractNo: `HT-${pickInt(rng, 2026, 2026)}${String(pickInt(rng, 100, 999))}-${pickInt(rng, 10, 99)}`,
          contractAmount: d2(amount),
          deliveryTerms: `合同生效后 ${pickInt(rng, 20, 45)} 天内交货`,
          paymentTerms: pickOne(rng, ['预付 30%，到货验收后付 65%，质保 5%', '预付 50%，到货后付 50%', '全额预付']),
          status: confirmed ? 'CONFIRMED' : 'PENDING',
          confirmedAt: confirmed ? addDays(orderDate, 2) : null,
          confirmedById: confirmed ? purchaser.id : null,
          remark: `${MARK} 合同演示`,
        },
      })
      stats.purchaseContract++
    }
    if (status === 'CANCELLED') {
      // CANCELLED 订单配一份 VOIDED 合同（已确认后作废）
      await prisma.purchaseContract.create({
        data: {
          orderId: order.id,
          contractNo: code,
          supplierContractNo: `HT-VOID-${pickInt(rng, 100, 999)}`,
          contractAmount: d2(amount),
          deliveryTerms: '合同生效后 30 天内交货',
          paymentTerms: '预付 30%，到货后付 70%',
          status: 'VOIDED',
          confirmedAt: addDays(orderDate, 2),
          confirmedById: purchaser.id,
          voidReason: '供应商无法按期交货，协商取消',
          remark: `${MARK} 作废合同演示`,
        },
      })
      stats.purchaseContract++
    }
    return { order, rows, amount, ctx }
  }

  /** 付款构造器：按比例生成计划/实付行并回写 paidAmount */
  async function addPayments(order, plan, opts = {}) {
    // plan: [{type, ratio|amount, status, daysAgo}]
    let paidSum = 0
    for (const p of plan) {
      const amt = p.amount != null ? p.amount : Math.round((opts.baseAmount * p.ratio) / 100)
      await prisma.purchasePayment.create({
        data: {
          orderId: order.id,
          type: p.type,
          amount: d2(amt),
          status: p.status,
          paidAt: addDays(opts.orderDate, p.daysAgo),
          method: p.status === 'PAID' ? pickOne(mulberry32(hashStr(order.code + p.type)), PAY_METHODS) : null,
          voucherNo: p.status === 'PAID' ? `PAY${pickInt(mulberry32(hashStr(order.code + 'v' + p.type)), 100000, 999999)}` : null,
          invoiceNo: p.status === 'PAID' && p.type !== 'REFUND' ? `INV${pickInt(mulberry32(hashStr(order.code + 'i' + p.type)), 100000, 999999)}` : null,
          createdById: purchaser.id,
          remark: `${MARK} ${p.type} ${p.status}`,
        },
      })
      stats.purchasePayment++
      if (p.status === 'PAID') paidSum += amt
    }
    if (paidSum !== 0) {
      // 增量回写（REFUND 负数冲减）：多次调用不互相覆盖
      await prisma.purchaseOrder.update({ where: { id: order.id }, data: { paidAmount: { increment: d2(paidSum) } } })
    }
    return paidSum
  }

  // 链A（p0）：PR→SR(ORDERED)→订单 COMPLETED：30%+60% 已付、5% 质保待付；两批全量到货
  const A = prByTag['链A']
  const orderA = await createOrder({ ctx: A.ctx, status: 'COMPLETED', opts: { rows: A.rows, key: 'A', category: A.rows[0].category } })
  await addPayments(orderA.order, [
    { type: 'PREPAYMENT', ratio: 30, status: 'PAID', daysAgo: 3 },
    { type: 'TAIL', ratio: 60, status: 'PAID', daysAgo: 25 },
    { type: 'TAIL', ratio: 5, status: 'PLANNED', daysAgo: 200 },
  ], { baseAmount: orderA.amount, orderDate: orderA.order.orderDate })

  // 链B（p1）：主单 COMPLETED（50/50 全付）+ 追加单 COMPLETED（全款）+ 退款一笔
  const B = prByTag['链B']
  const orderB1 = await createOrder({ ctx: B.ctx, status: 'COMPLETED', opts: { rows: B.rows, key: 'B1' } })
  await addPayments(orderB1.order, [
    { type: 'PREPAYMENT', ratio: 50, status: 'PAID', daysAgo: 4 },
    { type: 'TAIL', ratio: 50, status: 'PAID', daysAgo: 30 },
  ], { baseAmount: orderB1.amount, orderDate: orderB1.order.orderDate })
  const rngB = mulberry32(hashStr('dfpe-B2'))
  const supRows = makeMaterialRows(rngB, 2)
  const orderB2 = await createOrder({ ctx: B.ctx, status: 'COMPLETED', opts: { rows: supRows, key: 'B2', supplementaryOfId: orderB1.order.id, remarkSuffix: '（追加采购）' } })
  await addPayments(orderB2.order, [{ type: 'FULL', ratio: 100, status: 'PAID', daysAgo: 10 }], { baseAmount: orderB2.amount, orderDate: orderB2.order.orderDate })
  // 退款：质量扣罚冲减（负数冲抵 paidAmount）
  const refundAmt = -Math.round(orderB1.amount * 0.02)
  await addPayments(orderB1.order, [{ type: 'REFUND', amount: refundAmt, status: 'PAID', daysAgo: 35 }], { baseAmount: 0, orderDate: orderB1.order.orderDate })

  // 链D（p5 PR PROCESSING）：采购直接发起订单 CONTRACT_PENDING（合同待确认）
  const D = prByTag['链D']
  const orderD = await createOrder({ ctx: D.ctx, status: 'CONTRACT_PENDING', opts: { key: 'D' } })

  // 链E（p9）：CONFIRMED 合同刚确认：30% 已付 + 70% 尾款待付
  const E = prByTag['链E']
  const orderE = await createOrder({ ctx: E.ctx, status: 'CONFIRMED', opts: { rows: E.rows, key: 'E' } })
  await addPayments(orderE.order, [
    { type: 'PREPAYMENT', ratio: 30, status: 'PAID', daysAgo: 5 },
    { type: 'TAIL', ratio: 70, status: 'PLANNED', daysAgo: 45 },
  ], { baseAmount: orderE.amount, orderDate: orderE.order.orderDate })

  // 链F（p10）：SHIPPED 在途：30% 已付；1 批 PENDING 到货
  const F = prByTag['链F']
  const orderF = await createOrder({ ctx: F.ctx, status: 'SHIPPED', opts: { rows: F.rows, key: 'F' } })
  await addPayments(orderF.order, [{ type: 'PREPAYMENT', ratio: 30, status: 'PAID', daysAgo: 6 }], { baseAmount: orderF.amount, orderDate: orderF.order.orderDate })

  // 链G（p11）：PREPARING 已付款备货：30% 已付
  const G = prByTag['链G']
  const orderG = await createOrder({ ctx: G.ctx, status: 'PREPARING', opts: { rows: G.rows, key: 'G' } })
  await addPayments(orderG.order, [{ type: 'PREPAYMENT', ratio: 30, status: 'PAID', daysAgo: 4 }], { baseAmount: orderG.amount, orderDate: orderG.order.orderDate })

  // 独立订单：DRAFT（p8）/ ORDERED（p4）/ PARTIAL（p6，3 批含拒收）/ CANCELLED（p7）
  await createOrder({ ctx: Pm[8], status: 'DRAFT', opts: { key: 'X1' } })
  await createOrder({ ctx: Pm[4], status: 'ORDERED', opts: { key: 'X2' } })
  const orderPartial = await createOrder({ ctx: Pm[6], status: 'PARTIAL', opts: { key: 'X3' } })
  await addPayments(orderPartial.order, [
    { type: 'PREPAYMENT', ratio: 30, status: 'PAID', daysAgo: 5 },
    { type: 'TAIL', ratio: 40, status: 'PAID', daysAgo: 20 },
  ], { baseAmount: orderPartial.amount, orderDate: orderPartial.order.orderDate })
  await createOrder({ ctx: Pm[7], status: 'CANCELLED', opts: { key: 'X4', remarkSuffix: '（供应商缺货取消）' } })

  // ═══════════ 3. 采购需求 SupplierRequest（8 张）═══════════
  // 链A/B 的 ORDERED SR（orderId 已建好）；C/P/D 链的 QUOTED/PUBLISHED/DRAFT；独立 CANCELLED + 补两张
  async function createSR({ ctx, status, requestId, order, rows, brand, key }) {
    const rng = mulberry32(hashStr('dfpe-sr-' + ctx.project.code + key))
    seqSr++
    const quoted = ['QUOTED', 'ORDERED'].includes(status)
    const quoteAmount = quoted ? rows.reduce((s, r) => s + r.quantity * r.unitPrice, 0) : null
    const sr = await prisma.supplierRequest.create({
      data: {
        projectId: ctx.project.id,
        code: codeOf('SR', ctx.project, seqSr),
        requestId: requestId ?? null,
        brand,
        supplierId: quoted ? pickOne(rng, suppliers).id : null,
        title: `${brand ?? '综合'}物料询价`,
        category: rows[0].category,
        status,
        expectedDate: addDays(T0, pickInt(rng, 10, 35)),
        quoteAmount: quoteAmount != null ? d2(quoteAmount) : null,
        quoteNote: quoted ? `含运费；交期 ${pickInt(rng, 15, 40)} 天；${pickOne(rng, ['款到发货', '预付 30%', '月结 30 天'])}` : null,
        quotedAt: quoted ? addDays(T0, -pickInt(rng, 3, 15)) : null,
        orderId: order?.id ?? null,
        creatorId: purchaser.id,
        remark: `${MARK} ${status} 演示`,
        createdAt: addDays(T0, -pickInt(rng, 8, 30)),
        items: {
          create: rows.map((r) => ({
            name: r.name, spec: r.spec, param: null, brand: r.brand ?? brand,
            quantity: d2(r.quantity), unit: r.unit,
            unitPrice: quoted ? d2(r.unitPrice) : null,
            remark: null,
            sourceRequestItemIds: [],
          })),
        },
      },
      include: { items: true },
    })
    stats.supplierRequest++
    stats.supplierRequestItem += sr.items.length
    return sr
  }
  // ORDERED（链到订单 A/B）
  await createSR({ ctx: A.ctx, status: 'ORDERED', requestId: A.pr.id, order: orderA.order, rows: A.rows, brand: pickOne(A.rng, ['华驱', '澜控', '晟泰']), key: 'S1' })
  await createSR({ ctx: B.ctx, status: 'ORDERED', requestId: B.pr.id, order: orderB1.order, rows: B.rows, brand: pickOne(B.rng, ['九方', '锐立', '欧谟']), key: 'S2' })
  // QUOTED ×2（链C 的 PR 分解出两个品牌包）
  const C = prByTag['链C']
  await createSR({ ctx: C.ctx, status: 'QUOTED', requestId: C.pr.id, rows: makeMaterialRows(mulberry32(hashStr('dfpe-sr3a')), 2, 'ELECTRICAL'), brand: '澜控', key: 'S3' })
  await createSR({ ctx: C.ctx, status: 'QUOTED', requestId: C.pr.id, rows: makeMaterialRows(mulberry32(hashStr('dfpe-sr3b')), 2, 'MECHANICAL'), brand: '晟泰', key: 'S4' })
  // PUBLISHED / DRAFT（链上的 PR3/PR4）
  const c3 = Pm[3], c4 = Pm[4]
  const prD2 = await prisma.purchaseRequest.findFirst({ where: { projectId: c3.project.id, remark: { contains: MARK } }, orderBy: { code: 'asc' } })
  await createSR({ ctx: c3, status: 'PUBLISHED', requestId: prD2?.id ?? null, rows: makeMaterialRows(mulberry32(hashStr('dfpe-sr5')), 3), brand: null, key: 'S5' })
  await createSR({ ctx: c4, status: 'DRAFT', requestId: null, rows: makeMaterialRows(mulberry32(hashStr('dfpe-sr6')), 2), brand: null, key: 'S6' })
  // CANCELLED（独立）
  await createSR({ ctx: Pm[2], status: 'CANCELLED', requestId: C.pr.id, rows: makeMaterialRows(mulberry32(hashStr('dfpe-sr7')), 2), brand: '欧谟', key: 'S7' })

  // ═══════════ 4. 到货清点 GoodsArrival（8 批，覆盖 PENDING/RECEIVED/PARTIAL/REJECTED）═══════════
  /** 到货构造：confirmedAt 保证在 arrivalDate 之后 0~3 天 */
  async function createArrival({ ctx, order, batchSeq, status, rows, key, confirmed = true }) {
    const rng = mulberry32(hashStr('dfpe-ar-' + order.code + key))
    const receiver = memberOf(ctx, 3)
    const arrivalDate = addDays(order.orderDate ?? T0, pickInt(rng, 8, 30))
    const ar = await prisma.goodsArrival.create({
      data: {
        projectId: ctx.project.id,
        orderId: order.id,
        batchNo: `${order.code}-${batchSeq}`,
        supplierId: order.supplierId,
        arrivalDate,
        status,
        remark: `${MARK} 到货批次 ${batchSeq}`,
        createdById: purchaser.id,
        deliveryType: order.deliveryType,
        shippingAddress: null,
        receiverId: receiver.id,
        confirmedById: confirmed ? receiver.id : null,
        confirmedAt: confirmed ? addDays(arrivalDate, pickInt(rng, 0, 3)) : null,
        proofNote: confirmed ? `送货单号 SH${pickInt(rng, 100000, 999999)}，已拍照留档` : '待到货确认',
        items: {
          create: rows.map((r) => ({
            orderItemId: order.items[r.itemIdx].id,
            arrivedQty: d2(r.qty),
            defectQty: d2(r.defect ?? 0),
            rejectQty: d2(r.reject ?? 0),
            remark: r.note ?? null,
          })),
        },
      },
      include: { items: true },
    })
    stats.goodsArrival++
    stats.goodsArrivalItem += ar.items.length
    return ar
  }
  // 链A：两批全量 RECEIVED（批1 先到一半，批2 到齐）；receivedQty 回写
  {
    const o = orderA.order
    const half = o.items.map((it, i) => ({ itemIdx: i, qty: Math.round(Number(it.quantity) * 0.6), defect: 0, reject: 0, note: null }))
    await createArrival({ ctx: A.ctx, order: o, batchSeq: 1, status: 'RECEIVED', rows: half, key: 'a1' })
    const rest = o.items.map((it, i) => ({ itemIdx: i, qty: Number(it.quantity) - Math.round(Number(it.quantity) * 0.6), defect: 0, reject: 0, note: null }))
    await createArrival({ ctx: A.ctx, order: o, batchSeq: 2, status: 'RECEIVED', rows: rest, key: 'a2' })
    for (const it of o.items) await prisma.purchaseOrderItem.update({ where: { id: it.id }, data: { receivedQty: it.quantity } })
  }
  // 链B：主单+追加单各一批 RECEIVED
  {
    for (const o of [orderB1.order, orderB2.order]) {
      const rows = o.items.map((it, i) => ({ itemIdx: i, qty: Number(it.quantity), defect: 0, reject: 0, note: null }))
      await createArrival({ ctx: B.ctx, order: o, batchSeq: 1, status: 'RECEIVED', rows, key: 'b' + o.code.slice(-3) })
      for (const it of o.items) await prisma.purchaseOrderItem.update({ where: { id: it.id }, data: { receivedQty: it.quantity } })
    }
  }
  // 链F：SHIPPED 在途一批 PENDING
  {
    const rows = orderF.order.items.map((it, i) => ({ itemIdx: i, qty: Number(it.quantity), defect: 0, reject: 0, note: null }))
    await createArrival({ ctx: F.ctx, order: orderF.order, batchSeq: 1, status: 'PENDING', rows, key: 'f1', confirmed: false })
  }
  // PARTIAL 单（X3）：批1 RECEIVED 部分数量 / 批2 PARTIAL 缺件破损 / 批3 REJECTED 整单退回
  {
    const o = orderPartial.order
    const r1 = o.items.map((it, i) => ({ itemIdx: i, qty: Math.round(Number(it.quantity) * 0.5), defect: 0, reject: 0, note: null }))
    await createArrival({ ctx: Pm[6], order: o, batchSeq: 1, status: 'RECEIVED', rows: r1, key: 'p1' })
    const r2 = o.items.slice(0, 2).map((it, i) => ({ itemIdx: i, qty: Math.max(1, Math.round(Number(it.quantity) * 0.3)), defect: 2, reject: 1, note: '外包装破损，部分外观划伤' }))
    await createArrival({ ctx: Pm[6], order: o, batchSeq: 2, status: 'PARTIAL', rows: r2, key: 'p2' })
    const r3 = o.items.slice(0, 1).map((it, i) => ({ itemIdx: i, qty: 0, defect: 0, reject: Number(it.quantity), note: '铭牌参数与订单不符，整行退回' }))
    await createArrival({ ctx: Pm[6], order: o, batchSeq: 3, status: 'REJECTED', rows: r3, key: 'p3' })
    // receivedQty 回写（批1 批2 合格量）
    for (const it of o.items) {
      const got = r1.find((x) => x.itemIdx === o.items.indexOf(it))?.qty ?? 0
      const got2 = r2.find((x) => o.items[x.itemIdx]?.id === it.id)?.qty ?? 0
      await prisma.purchaseOrderItem.update({ where: { id: it.id }, data: { receivedQty: d2(got + got2) } })
    }
    // 维持订单 PARTIAL 语义（部分到货）
  }

  // ═══════════ 5. 费用报销 ExpenseClaim（30 张，状态谱 4/6/6/6/8）═══════════
  const CLAIM_STATUSES = [
    ...Array(4).fill('DRAFT'), ...Array(6).fill('SUBMITTED'), ...Array(6).fill('APPROVED'),
    ...Array(6).fill('REJECTED'), ...Array(8).fill('PAID'),
  ]
  // 打散到 12 项目（确定性）
  for (let i = 0; i < 30; i++) {
    const status = CLAIM_STATUSES[i]
    const ctx = Pm[i % 12]
    const rng = mulberry32(hashStr(`dfpe-claim-${ctx.project.code}-${i}`))
    const payee = memberOf(ctx, i)
    const itemCount = pickInt(rng, 1, 5)
    const items = []
    for (let k = 0; k < itemCount; k++) {
      const cat = pickOne(rng, expenseCats)
      const lo = { TRIP: 1500, LOGISTICS: 300, SITE_PURCHASE: 1000, RECEPTION: 500, RENTAL: 3000, REPAIR: 1000, TELECOM: 200, OFFICE: 150, INSURANCE: 2000, INSPECTION: 2000, OTHER: 200 }[cat.code] ?? 200
      const hi = lo * 8
      items.push({
        categoryId: cat.id,
        amount: d2(pickInt(rng, lo, hi)),
        expenseDate: addDays(T0, -pickInt(rng, 3, 60)),
        description: pickOne(rng, EXPENSE_DESCS[cat.code] ?? ['项目支出']),
      })
    }
    const total = items.reduce((s, x) => s + Number(x.amount), 0)
    const rejected = status === 'REJECTED'
    const approved = ['APPROVED', 'PAID'].includes(status)
    const paid = status === 'PAID'
    const createdAt = addDays(T0, -pickInt(rng, 2, 55))
    await prisma.expenseClaim.create({
      data: {
        projectId: ctx.project.id,
        payeeId: payee.id,
        status,
        totalAmount: d2(total),
        rejectedReason: rejected ? pickOne(rng, REJECT_REASONS_CLAIM) : null,
        approvedById: approved ? admin.id : null,
        approvedAt: approved ? addDays(createdAt, pickInt(rng, 1, 5)) : null,
        paidById: paid ? admin.id : null,
        paidAt: paid ? addDays(createdAt, pickInt(rng, 5, 15)) : null,
        remark: `${MARK} 报销演示 ${status}`,
        createdById: payee.id,
        createdAt,
        items: { create: items },
      },
    })
    stats.expenseClaim++
    stats.expenseItem += items.length
  }

  // ═══════════ 6. 汇总 ═══════════
  console.log('\n═══════ 填充汇总 ═══════')
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}`)
  console.log(`\n覆盖状态谱：`)
  console.log(`  PR: DRAFT1/SUBMITTED2/PROCESSING2/DECOMPOSED3/COMPLETED6/REJECTED2`)
  console.log(`  SR: DRAFT1/PUBLISHED1/QUOTED2/ORDERED2/CANCELLED1`)
  console.log(`  CG: DRAFT1/CONTRACT_PENDING1/CONFIRMED1/PREPARING1/SHIPPED1/ORDERED1/PARTIAL1/COMPLETED3(含追加1)/CANCELLED1`)
  console.log(`  HT: PENDING1/CONFIRMED7/VOIDED1；FK: PREPAYMENT/FULL/TAIL/REFUND × PLANNED/PAID`)
  console.log(`  AR: PENDING1/RECEIVED5/PARTIAL1/REJECTED1；EX: DRAFT4/SUBMITTED6/APPROVED6/REJECTED6/PAID8`)
  console.log('\n完成。')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
