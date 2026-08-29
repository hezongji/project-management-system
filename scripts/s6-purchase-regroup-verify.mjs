/**
 * S6 采购归单全链路验证（S6SMOKE 前缀，测试完即清）
 *
 * ★ 2026-08-25 重构核心链路：
 *   采购任务（SupplierRequest 品牌任务，同供应商多品牌）→ 按供应商归单
 *   → /purchase-orders/generate 一键生成（1 供应商 1 张订单，1:N 合并）
 *   → 任务回写 ORDERED + orderId → 订单明细可溯源（品牌列保留）
 *
 * 链路：登录ADMIN → 建 3 个品牌任务（供应商A×2 品牌 + 供应商B×1 品牌,publish）
 *      → generate 归单 → 断言 2 张订单（A 单含 2 品牌 3 明细 / B 单 1 品牌 1 明细）
 *      → 断言任务全 ORDERED 且 同供应商 orderId 相同（1:N）、跨供应商不同
 *      → 订单金额 = 明细合计 → 负向用例（重复归单 400 / 未指定供应商 400）→ 清理
 */
import { PrismaClient } from '@prisma/client'

const BASE = process.env.S6_BASE || 'http://localhost:3001'
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
const srIds = []
const pfx = 'S6SMOKE'

try {
  header(`登录 ADMIN (${BASE})`)
  const login = await api('POST', '/auth/login', { body: { email: 'chenmuzhi@example.com', password: 'demo123456' } })
  assert(login.status === 200 && login.body?.success, '登录成功')
  token = login.body?.data?.token ?? ''
  assert(!!token, '拿到 token')

  header('定位测试项目 DEMO25031')
  const projects = await api('GET', '/projects?page=1&limit=100', { token })
  let proj = projects.body?.data?.items?.find((p) => p.code === 'DEMO25031') || projects.body?.data?.items?.[0]
  assert(!!proj?.id, `拿到项目 ${proj?.code ?? '?'}`)
  const projectId = proj.id

  header('找 2 个供应商 ExternalOrg(SUPPLIER)')
  const orgs = await api('GET', '/external-orgs?page=1&limit=100', { token })
  const suppliers = (orgs.body?.data?.items ?? []).filter((o) => (o.type ?? o.orgType) === 'SUPPLIER')
  assert(suppliers.length >= 2, `找到 ≥2 个供应商（实际 ${suppliers.length}）`)
  const supA = suppliers[0]
  const supB = suppliers[1]
  log(`  供应商A: ${supA?.name}  供应商B: ${supB?.name}`)

  // ── 建 3 个品牌任务：A 供应商 × 2 品牌 + B 供应商 × 1 品牌（直接发布）──
  header('POST 创建采购任务（供应商A-品牌X / A-品牌Y / B-品牌Z，publish）')
  const mk = async (label, supplierId, brand, items) => {
    const r = await api('POST', '/supplier-requests', {
      token,
      body: {
        projectId, supplierId, title: `${pfx}-${label}`,
        category: 'MECHANICAL', publish: true, brand,
        items: items.map((it) => ({ ...it, unit: it.unit ?? '件' })),
      },
    })
    assert(r.status === 201 && r.body?.success, `创建 ${label} 成功（${r.status}）`, JSON.stringify(r.body?.message ?? '').slice(0, 100))
    const id = r.body?.data?.id ?? r.body?.data?.supplierRequest?.id ?? ''
    assert(!!id, `${label} 拿到 id`)
    srIds.push(id)
    return id
  }
  const srA_X = await mk('A-X 密封泵', supA.id, 'X牌', [
    { name: 'S6SMOKE 螺杆泵', spec: 'G50-1', quantity: 2, unit: '台', unitPrice: 6800, brand: 'X牌' },
    { name: 'S6SMOKE 联轴器', spec: 'LB-200', quantity: 2, unit: '套', unitPrice: 450, brand: 'X牌' },
  ])
  const srA_Y = await mk('A-Y 阀门', supA.id, 'Y牌', [
    { name: 'S6SMOKE 球阀', spec: 'DN80-16', quantity: 6, unit: '只', unitPrice: 190, brand: 'Y牌' },
  ])
  const srB_Z = await mk('B-Z 电缆', supB.id, 'Z牌', [
    { name: 'S6SMOKE 电缆', spec: 'YJV-3x6', quantity: 50, unit: '米', unitPrice: 28, brand: 'Z牌' },
  ])
  assert(srIds.length === 3, '共 3 个任务')

  header('POST /purchase-orders/generate 按供应商归单')
  const gen = await api('POST', '/purchase-orders/generate', {
    token, body: { supplierRequestIds: srIds, remark: `${pfx} 验证` },
  })
  assert(gen.status === 201 && gen.body?.success, `generate 成功（${gen.status}）`, JSON.stringify(gen.body?.message ?? '').slice(0, 160))
  const orders = gen.body?.data?.orders ?? []
  assert(orders.length === 2, `按供应商归单生成 2 张订单（实际 ${orders.length}）`)
  const orderA = orders.find((o) => o.supplierName === supA.name)
  const orderB = orders.find((o) => o.supplierName === supB.name)
  assert(!!orderA && !!orderB, '两张订单分别归属供应商A/B')
  assert(orderA?.brands?.length === 2 && orderA?.brands?.includes('X牌') && orderA?.brands?.includes('Y牌'), `A 单合并 2 品牌（${(orderA?.brands ?? []).join('/')}）`)
  assert(orderA?.itemCount === 3, `A 单明细 3 条（品牌X 2 条 + 品牌Y 1 条，实际 ${orderA?.itemCount}）`)
  assert(orderB?.itemCount === 1, `B 单明细 1 条（实际 ${orderB?.itemCount}）`)
  const expAmtA = 2 * 6800 + 2 * 450 + 6 * 190
  assert(orderA?.amount === expAmtA, `A 单金额 = 明细合计 ${expAmtA}（实际 ${orderA?.amount}）`)

  header('任务回写验证（同供应商 → 同一 orderId = 1:N 核心）')
  const getSr = async (id) => {
    const r = await api('GET', `/supplier-requests/${id}`, { token })
    return r.body?.data ?? r.body
  }
  const [sr1, sr2, sr3] = await Promise.all([getSr(srA_X), getSr(srA_Y), getSr(srB_Z)])
  assert(sr1?.status === 'ORDERED' && sr2?.status === 'ORDERED' && sr3?.status === 'ORDERED', `3 任务状态均 ORDERED（${[sr1?.status, sr2?.status, sr3?.status].join('/')}）`)
  assert(!!sr1?.orderId && sr1.orderId === sr2.orderId, `同供应商两任务共挂 1 张订单（${sr1?.orderId === sr2?.orderId ? '一致' : '不一致'}）`)
  assert(!!sr3?.orderId && sr3.orderId !== sr1.orderId, '跨供应商订单不同')
  assert(sr1?.orderId === orderA?.id, '任务 orderId 与生成订单 A 一致')

  header('订单明细溯源（GET /purchase-orders/{id}）')
  const od = await api('GET', `/purchase-orders/${orderA.id}`, { token })
  const odData = od.body?.data?.order ?? od.body?.data
  const itemBrands = new Set((odData?.items ?? []).map((i) => i.brand).filter(Boolean))
  assert(itemBrands.size === 2 && itemBrands.has('X牌') && itemBrands.has('Y牌'), `订单明细保留品牌列（${Array.from(itemBrands).join('/')}）`)
  assert(odData?.status === 'DRAFT', `归单生成订单初始 DRAFT（实际 ${odData?.status}）`)

  // ── 负向用例 ──
  header('负向：重复归单 → 400')
  const again = await api('POST', '/purchase-orders/generate', { token, body: { supplierRequestIds: [srA_X, srA_Y] } })
  assert(again.status === 400 && /已转订单/.test(again.body?.message ?? ''), `重复归单被拒（${again.status} ${again.body?.message ?? ''}）`)

  header('负向：未指定供应商 → 400')
  const srNoSup = await mk('A-NOSUP 未指定', supA.id, 'N牌', [
    { name: 'S6SMOKE 法兰', spec: 'DN80', quantity: 4, unit: '只', unitPrice: 95, brand: 'N牌' },
  ])
  const clrSup = await api('PATCH', `/supplier-requests/${srNoSup}`, { token, body: { supplierId: null } })
  assert(clrSup.status === 200, '任务供应商已清空（PATCH supplierId=null）')
  const noSup = await api('POST', '/purchase-orders/generate', { token, body: { supplierRequestIds: [srNoSup] } })
  assert(noSup.status === 400 && /未.*指定供应商|尚未指定/.test(noSup.body?.message ?? ''), `未指定供应商被拒（${noSup.status} ${noSup.body?.message ?? ''}）`)

  // ── 清理 ──
  header('清理 S6SMOKE 测试数据')
  try {
    const delSRItems = await prisma.supplierRequestItem.deleteMany({ where: { supplierRequest: { title: { contains: pfx } } } })
    const delSR = await prisma.supplierRequest.deleteMany({ where: { title: { contains: pfx } } })
    const delItems = await prisma.purchaseOrderItem.deleteMany({ where: { order: { OR: [{ title: { contains: pfx } }, { remark: { contains: pfx } }] } } })
    const delOrders = await prisma.purchaseOrder.deleteMany({ where: { OR: [{ title: { contains: pfx } }, { remark: { contains: pfx } }] } })
    log(`  删除: srItems=${delSRItems.count} sr=${delSR.count} orderItems=${delItems.count} orders=${delOrders.count}`)
  } catch (e) {
    log('  清理异常:', e?.message)
  }
  const leftoverSr = await prisma.supplierRequest.count({ where: { title: { contains: pfx } } })
  const leftover = await prisma.purchaseOrder.count({ where: { OR: [{ title: { contains: pfx } }, { remark: { contains: pfx } }] } })
  assert(leftover === 0 && leftoverSr === 0, `清理后 count=0 (orders=${leftover}, sr=${leftoverSr})`)

  log(`\n━━━ 结果：${passed} ✓ / ${failed} ✗`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
} catch (e) {
  log('\n✗ 异常中断:', e?.message ?? e)
  await prisma.$disconnect()
  process.exit(1)
}
