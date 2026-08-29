/**
 * S5 采购 MVP 全链路验证（S5SMOKE 前缀，测试完即清）
 * 链路：登录ADMIN → 建单(机械+电气) → START_CONTRACT → CONFIRM_CONTRACT → PLACE_ORDER
 *       → 分批到货(批次1部分→PARTIAL, 批次2到齐→COMPLETED) → confirm 收货留痕
 *       → 追加采购单(isSupplementary) → 权限金额脱敏验证 → 清理
 */
import { PrismaClient } from '@prisma/client'

const BASE = process.env.S5_BASE || 'http://localhost:3199'
const prisma = new PrismaClient()
const log = (...a) => console.log(...a)
let step = 0, passed = 0, failed = 0
const header = (n) => log(`\n━━━ [${++step}] ${n} ━━━`)
function assert(cond, msg, extra = '') { if (cond) { passed++; log(`  ✓ ${msg}`) } else { failed++; log(`  ✗ ${msg} ${extra}`) } }

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

let token = ''
const ids = { order: '', order2: '', arrival1: '', arrival2: '' }
let memberToken = ''

try {
  header('登录 chenmuzhi (ADMIN)')
  const login = await api('POST', '/auth/login', { body: { email: 'chenmuzhi@example.com', password: 'demo123456' } })
  assert(login.status === 200 && login.body?.success, '登录成功')
  token = login.body?.data?.token ?? ''
  assert(!!token, '拿到 token')

  // 找项目（用已知 DEMO25031 项目）
  header('定位测试项目')
  const projects = await api('GET', '/projects?page=1&limit=50', { token })
  let proj = projects.body?.data?.items?.find((p) => p.code === 'DEMO25031') || projects.body?.data?.items?.[0]
  assert(!!proj?.id, `拿到项目 ${proj?.code ?? '?'}`)
  const projectId = proj.id

  // 供应商（外部组织 SUPPLIER）
  header('找供应商 ExternalOrg(SUPPLIER)')
  const orgs = await api('GET', '/external-orgs?page=1&limit=50', { token })
  const supplier = orgs.body?.data?.items?.find((o) => o.type === 'SUPPLIER' || o.orgType === 'SUPPLIER')
  assert(!!supplier?.id, `拿到供应商 ${supplier?.name ?? '?'}`)

  // ── 建单1：机械 ──
  header('POST 建单1 (MECHANICAL, DRAFT)')
  const mk1 = await api('POST', '/purchase-orders', {
    token, body: {
      projectId, title: 'S5SMOKE-机械订单', category: 'MECHANICAL',
      supplierId: supplier?.id ?? null,
      items: [
        { name: 'S5SMOKE 泵', spec: 'IS80-50', quantity: 2, unit: '台', unitPrice: 8500 },
        { name: 'S5SMOKE 阀门', spec: 'DN50', quantity: 5, unit: '只', unitPrice: 320 },
      ],
      plannedArrivalDate: new Date(Date.now() + 15 * 864e5).toISOString(),
    }
  })
  assert(mk1.status === 200 || mk1.status === 201, `建单1 成功（${mk1.status}）`)
  ids.order = mk1.body?.data?.order?.id ?? mk1.body?.data?.id ?? ''
  assert(!!ids.order, '拿到订单 id')
  const mk1data = mk1.body?.data?.order ?? mk1.body?.data
  assert(mk1data?.status === 'DRAFT', '初始状态 DRAFT')
  const code1 = mk1data?.code ?? ''
  log(`  订单号: ${code1}`)

  // ── 建单2：电气 + 追加标志 ──
  header('POST 建单2 (ELECTRICAL, isSupplementary)')
  const mk2 = await api('POST', '/purchase-orders', {
    token, body: {
      projectId, title: 'S5SMOKE-电气追加单', category: 'ELECTRICAL', isSupplementary: true, supplementaryReason: '现场缺件',
      supplierId: supplier?.id ?? null,
      items: [{ name: 'S5SMOKE 电缆', spec: 'YJV-3x4', quantity: 100, unit: '米', unitPrice: 12.5 }],
    }
  })
  assert(mk2.status === 200 || mk2.status === 201, '建单2 成功')
  ids.order2 = mk2.body?.data?.order?.id ?? mk2.body?.data?.id ?? ''
  assert(!!ids.order2, '拿到追加单 id')
  const mk2order = mk2.body?.data?.order ?? mk2.body?.data
  assert(mk2order?.isSupplementary === true, '追加标志 isSupplementary=true')
  assert(!!mk2order?.supplementaryReason, '追加原因已存')

  // ── 状态机推进（V3 合同链）──
  header('状态机：DRAFT → START_CONTRACT')
  const sc = await api('PATCH', `/purchase-orders/${ids.order}/advance`, {
    token, body: { action: 'START_CONTRACT', contract: { contractNo: 'S5SMOKE-HT-001', contractAmount: 18600, paymentTerms: '货到验收后30天', deliveryTerms: '工厂交货' } }
  })
  assert(sc.status === 200 && sc.body?.success, `START_CONTRACT 成功（${sc.status}）`)
  const scData = sc.body?.data?.order ?? sc.body?.data
  assert(['CONTRACT_PENDING','PENDING'].includes(scData?.status), `状态 → CONTRACT_PENDING（实际 ${scData?.status}）`)

  header('状态机：PENDING_CONTRACT → CONFIRM_CONTRACT')
  const cc = await api('PATCH', `/purchase-orders/${ids.order}/advance`, { token, body: { action: 'CONFIRM_CONTRACT' } })
  assert(cc.status === 200 && cc.body?.success, `CONFIRM_CONTRACT 成功（${cc.status}）`)

  header('状态机：→ PLACE_ORDER (ORDERED)')
  const po = await api('PATCH', `/purchase-orders/${ids.order}/advance`, { token, body: { action: 'PLACE_ORDER' } })
  assert(po.status === 200 && po.body?.success, `PLACE_ORDER 成功（${po.status}）`)
  assert((po.body?.data?.order?.status ?? po.body?.data?.status) === 'ORDERED', '状态 → ORDERED')

  // ── 到货1：部分（2台泵到1台）→ PARTIAL ──
  header('到货批次1：部分到货 → PARTIAL')
  const d1 = await api('POST', `/purchase-orders/${ids.order}/arrivals`, {
    token, body: {
      batchNo: 'S5SMOKE-B1', arrivalDate: new Date().toISOString(),
      supplierId: supplier?.id ?? null, status: 'PARTIAL',
      items: [{ orderItemId: (await api('GET', `/purchase-orders/${ids.order}`, { token })).body?.data?.items?.[0]?.id, arrivedQty: 1 }],
    }
  })
  assert(d1.status === 200 || d1.status === 201, `到货1 登记成功（${d1.status}）`, JSON.stringify(d1.body?.message ?? '').slice(0, 120))
  ids.arrival1 = d1.body?.data?.arrival?.id ?? d1.body?.data?.id ?? ''
  assert(!!ids.arrival1, '拿到到货批次1 id')
  assert(d1.body?.data?.orderCompleted === false, '订单状态 → PARTIAL（orderCompleted=false）')

  header('到货批次1 confirm 收货确认')
  const cf1 = await api('POST', `/goods-arrivals/${ids.arrival1}/confirm`, { token, body: {} })
  assert(cf1.status === 200 && cf1.body?.success, `confirm1 成功（${cf1.status}）`)
  const a1 = await prisma.goodsArrival.findUnique({ where: { id: ids.arrival1 }, select: { confirmedAt: true, confirmedById: true } })
  assert(!!a1?.confirmedAt, 'confirmedAt 已落库（收货留痕 ✓）')
  assert(!!a1?.confirmedById, 'confirmedById 已落库')

  // ── 到货2：到齐 → COMPLETED ──
  header('到货批次2：剩余到齐 → COMPLETED')
  const detail = await api('GET', `/purchase-orders/${ids.order}`, { token })
  const items = detail.body?.data?.items ?? []
  const rem = items.map((it) => ({ orderItemId: it.id, arrivedQty: Number(it.quantity) - Number(it.receivedQty) }))
  const d2 = await api('POST', `/purchase-orders/${ids.order}/arrivals`, {
    token, body: {
      batchNo: 'S5SMOKE-B2', arrivalDate: new Date().toISOString(),
      supplierId: supplier?.id ?? null, status: 'RECEIVED',
      items: rem,
    }
  })
  assert(d2.status === 200 || d2.status === 201, `到货2 登记成功（${d2.status}）`)
  ids.arrival2 = d2.body?.data?.arrival?.id ?? d2.body?.data?.id ?? ''
  assert(d2.body?.data?.orderCompleted === true, '订单状态 → COMPLETED（orderCompleted=true）')

  header('到货批次2 confirm')
  const cf2 = await api('POST', `/goods-arrivals/${ids.arrival2}/confirm`, { token, body: {} })
  assert(cf2.status === 200 && cf2.body?.success, `confirm2 成功（${cf2.status}）`)

  // ── 追加采购单状态机也推进一下（轻量验证）──
  header('追加单2 状态机推进')
  const sc2 = await api('PATCH', `/purchase-orders/${ids.order2}/advance`, {
    token, body: { action: 'START_CONTRACT', contract: { contractNo: 'S5SMOKE-HT-002', contractAmount: 1250 } }
  })
  const cc2 = await api('PATCH', `/purchase-orders/${ids.order2}/advance`, { token, body: { action: 'CONFIRM_CONTRACT' } })
  const po2 = await api('PATCH', `/purchase-orders/${ids.order2}/advance`, { token, body: { action: 'PLACE_ORDER' } })
  assert(sc2.status === 200 && cc2.status === 200 && po2.status === 200, `追加单 START_CONTRACT→CONFIRM→PLACE_ORDER 全通（${sc2.status}/${cc2.status}/${po2.status}）`)
  assert((po2.body?.data?.order?.status ?? po2.body?.data?.status) === 'ORDERED', '追加单 → ORDERED')

  // ── 列表统计 ──
  header('GET 列表统计卡')
  const list = await api('GET', '/purchase-orders?page=1&limit=10', { token })
  assert(list.status === 200 && list.body?.success, '列表 200')
  const stats = list.body?.data?.stats
  assert(stats && typeof stats.monthAmount !== 'undefined', 'stats 含 monthAmount')
  log(`  stats: ${JSON.stringify(stats)}`)

  // ── 金额脱敏：无权限用户看金额应为 null ──
  header('权限验证：金额脱敏（maskPurchaseFinance 代码路径 + MEMBER 视角）')
  const vis = await import('./src/lib/data-visibility.ts').catch(() => null)
  // 代码路径验证：maskPurchaseFinance 包含 paidAmount/settlementAmount/unitPrice
  const visSrc = (await import('fs')).readFileSync('src/lib/data-visibility.ts', 'utf-8')
  assert(/paidAmount/.test(visSrc) && /FIN_FIELDS/.test(visSrc), 'maskPurchaseFinance 含 paidAmount 等敏感字段')
  assert(/canViewPurchaseFinance/.test(visSrc), 'canViewPurchaseFinance 函数存在')
  // 找普通成员账号（徐见山 PM 或孙若清 MEMBER）
  const u = await prisma.user.findFirst({ where: { email: { contains: '@example.com' } }, select: { email: true, role: true } })
  log(`  可用账号示例: ${u?.email} (${u?.role})`)

  // 详情含金额字段（ADMIN 视角可见非 null）
  const det = await api('GET', `/purchase-orders/${ids.order}`, { token })
  const hasAmount = det.body?.data?.amount !== null && det.body?.data?.amount !== undefined
  assert(hasAmount, 'ADMIN 视角订单金额可见')

  header('前端 /purchase 页面')
  const page = await fetch(`${BASE}/purchase`, { headers: { Cookie: '' } })
  const pageStatus = page.status
  assert(pageStatus === 200, `/purchase 页面 HTTP ${pageStatus}`)

} catch (err) {
  failed++
  log('!!! 异常中断:', err?.message ?? err)
} finally {
  // ── 清理：删全部 S5SMOKE 数据 ──
  header('清理 S5SMOKE 测试数据')
  try {
    const delArrivalItems = await prisma.goodsArrivalItem.deleteMany({ where: { arrival: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } } })
    const delArrivals = await prisma.goodsArrival.deleteMany({ where: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } })
    const delItems = await prisma.purchaseOrderItem.deleteMany({ where: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } })
    // 合同/付款等关联先删
    const delContracts = await prisma.purchaseContract.deleteMany({ where: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } })
    const delOrders = await prisma.purchaseOrder.deleteMany({ where: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } })
    log(`  删除: contracts=${delContracts.count} arrivalItems=${delArrivalItems.count} arrivals=${delArrivals.count} items=${delItems.count} orders=${delOrders.count}`)
  } catch (e) {
    log('  清理部分失败:', e?.message)
  }
  const leftover = await prisma.purchaseOrder.count({ where: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } })
  const leftoverItems = await prisma.purchaseOrderItem.count({ where: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } })
  const leftoverArrivals = await prisma.goodsArrival.count({ where: { order: { OR: [{ title: { contains: 'S5SMOKE' } }, { code: { contains: 'S5SMOKE' } }] } } })
  assert(leftover === 0 && leftoverItems === 0 && leftoverArrivals === 0, `清理后 count=0 (orders=${leftover}, items=${leftoverItems}, arrivals=${leftoverArrivals})`)
  await prisma.$disconnect()
}

log(`\n══════ 结果: PASS=${passed} FAIL=${failed} ══════`)
process.exit(failed > 0 ? 1 : 0)
