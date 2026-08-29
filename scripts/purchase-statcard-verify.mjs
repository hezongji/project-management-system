/**
 * ★ 2026-08-25 统计卡点击定位——数据链路验证（只读，不建不删任何数据）
 *
 * 采购管理页顶部「待处理 / 进行中 / 已完成」三张统计卡新增点击定位：
 *   点卡片 = statusFilter 设为该卡状态组（PENDING/ACTIVE 聚合或 COMPLETED 单状态）
 *   → 列表按组过滤 → 平滑滚动到首条并复用 focus-ring-flash 闪烁。
 *
 * 因 API 仅支持单 status 筛选（本需求不动 API），聚合组由前端 fetchOrdersResp
 * 逐状态分块拉取（100/页、每状态上限 500）后按 createdAt 倒序合并、前端分页 20/页。
 * 本脚本用真实线上 API 复现页面取数逻辑并断言：
 *   1) 8 个单状态 limit=1 计数接口可用（statusCounts 数据源，卡片数字与"暂无"判断依据）
 *   2) 聚合组合并结果 ≡ 全量列表客户端过滤结果（id 序列完全一致，排序口径正确）
 *   3) 前端分页切片正确（pages=ceil(total/20)，page=2 首条 = 全量第 21 条）
 *   4) 组内 stats 逐字段求和 ≡ 全量 stats 对应状态字段（金额卡/合并口径还原正确）
 *
 * 用法：node scripts/purchase-statcard-verify.mjs [BASE]   （默认 http://localhost:3001）
 */
const BASE = process.argv[2] || process.env.STATCARD_BASE || 'http://localhost:3001'

const STATUS_GROUPS = {
  PENDING: { label: '待处理', statuses: ['DRAFT', 'CONTRACT_PENDING', 'CONFIRMED'] },
  ACTIVE: { label: '进行中', statuses: ['ORDERED', 'PREPARING', 'SHIPPED', 'PARTIAL'] },
}
const ALL_COUNT_STATUSES = [
  'DRAFT', 'CONTRACT_PENDING', 'CONFIRMED', 'ORDERED', 'PREPARING', 'SHIPPED', 'PARTIAL', 'COMPLETED',
]
const GROUP_CHUNK = 100 // 与页面 fetchOrdersResp 完全一致
const GROUP_MAX_PER_STATUS = 500

let step = 0, passed = 0, failed = 0
const log = (...a) => console.log(...a)
const header = (n) => log(`\n━━━ [${++step}] ${n} ━━━`)
function assert(cond, msg, extra = '') {
  if (cond) { passed++; log(`  ✓ ${msg}`) } else { failed++; log(`  ✗ ${msg} ${extra}`) }
}

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

/** 页面 fetchOrdersResp 的聚合组分支复现：逐状态分块拉取 → 合并 → createdAt 倒序 */
async function fetchGroupMerged(token, group, page) {
  const perStatus = await Promise.all(
    group.statuses.map(async (s) => {
      const items = []
      let stats
      for (let p = 1; p <= Math.ceil(GROUP_MAX_PER_STATUS / GROUP_CHUNK); p++) {
        const r = await api('GET', `/purchase-orders?page=${p}&limit=${GROUP_CHUNK}&status=${s}`, { token })
        const resp = r.body?.data
        if (r.status !== 200 || !resp) break
        if (!stats) stats = resp.stats
        items.push(...resp.items)
        if (resp.items.length < GROUP_CHUNK || p >= resp.pagination.pages) break
      }
      return { items, stats }
    }),
  )
  const merged = perStatus.flatMap((r) => r.items)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const pages = Math.max(1, Math.ceil(merged.length / 20))
  const safePage = Math.min(page, pages)
  const statsList = perStatus.map((r) => r.stats).filter(Boolean)
  const sumNum = (ns) => ns.reduce((a, b) => a + (b ?? 0), 0)
  const sumMoney = (ns) =>
    ns.length === 0 || ns.every((n) => n == null) ? null : sumNum(ns)
  return {
    items: merged.slice((safePage - 1) * 20, safePage * 20),
    all: merged,
    pagination: { page: safePage, pages, total: merged.length },
    stats: statsList.length
      ? {
          draft: sumNum(statsList.map((s) => s.draft)),
          completed: sumNum(statsList.map((s) => s.completed)),
          totalAmount: sumMoney(statsList.map((s) => s.totalAmount)),
        }
      : undefined,
  }
}

try {
  header(`登录 ADMIN (${BASE})`)
  const login = await api('POST', '/auth/login', { body: { email: 'chenmuzhi@example.com', password: 'demo123456' } })
  assert(login.status === 200 && login.body?.success, '登录成功')
  const token = login.body?.data?.token ?? ''
  assert(!!token, '拿到 token')

  // ── 1. statusCounts 数据源：8 个单状态计数接口 ──
  header('统计卡计数数据源（limit=1 取 total，页面 statusCounts 同款）')
  const counts = {}
  for (const s of ALL_COUNT_STATUSES) {
    const r = await api('GET', `/purchase-orders?limit=1&status=${s}`, { token })
    counts[s] = r.body?.data?.pagination?.total ?? -1
  }
  assert(Object.values(counts).every((n) => n >= 0), '8 个状态计数接口全部 200 且返回 total')
  log('  计数:', JSON.stringify(counts))
  const pendingCount = counts.DRAFT + counts.CONTRACT_PENDING + counts.CONFIRMED
  const activeCount = counts.ORDERED + counts.PREPARING + counts.SHIPPED + counts.PARTIAL
  log(`  → 卡片数字：待处理=${pendingCount}  进行中=${activeCount}  已完成=${counts.COMPLETED}`)

  // ── 2. 全量拉取作为基准（unfiltered，客户端过滤=用户在"全部状态"下看到的世界）──
  header('拉取全量订单作为基准（分页 100/页）')
  const all = []
  let allStats
  for (let p = 1; p <= 50; p++) {
    const r = await api('GET', `/purchase-orders?page=${p}&limit=100`, { token })
    const resp = r.body?.data
    if (!resp) break
    if (!allStats) allStats = resp.stats
    all.push(...resp.items)
    if (resp.items.length < 100 || p >= resp.pagination.pages) break
  }
  log(`  全量 ${all.length} 条`)

  // ── 3. 聚合组合并 ≡ 全量过滤（PENDING / ACTIVE 两组）──
  for (const [key, group] of Object.entries(STATUS_GROUPS)) {
    header(`聚合组 ${group.label}（${group.statuses.join('+')}）合并正确性`)
    const merged = await fetchGroupMerged(token, group, 1)
    const truth = all
      .filter((o) => group.statuses.includes(o.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    assert(merged.all.length === truth.length, `合并条数 = 全量过滤条数（${merged.all.length}）`)
    assert(
      merged.all.map((o) => o.id).join() === truth.map((o) => o.id).join(),
      '合并后 id 顺序与全量过滤(createdAt 倒序)完全一致',
    )
    assert(
      merged.pagination.pages === Math.max(1, Math.ceil(truth.length / 20)) &&
        merged.pagination.total === truth.length,
      `前端分页：pages=${merged.pagination.pages} total=${truth.length}`,
    )
    assert(
      merged.items.length === Math.min(20, truth.length) &&
        merged.items.map((o) => o.id).join() === truth.slice(0, 20).map((o) => o.id).join(),
      'page=1 切片 = 全量过滤前 20 条',
    )
    // 卡片计数一致性：点卡片后列表内容应与卡片计数同源同口径
    const cardCount = key === 'PENDING' ? pendingCount : activeCount
    assert(cardCount === truth.length, `卡片数字（${cardCount}）= 组内真实条数（${truth.length}）→ 点击不会误报"暂无"`)
    // 组内 stats 求和还原：stats 口径随筛选范围（组内只含组内状态；与单状态筛选行为一致）
    const expectDraft = group.statuses.includes('DRAFT') ? counts.DRAFT : 0
    const expectCompleted = group.statuses.includes('COMPLETED') ? counts.COMPLETED : 0
    assert(merged.stats?.draft === expectDraft, `合并 stats.draft=${merged.stats?.draft} = ${expectDraft}`)
    assert(merged.stats?.completed === expectCompleted, `合并 stats.completed=${merged.stats?.completed} = ${expectCompleted}`)
    if (merged.all.length > 20) {
      log(`  首条（点击卡片后将滚动定位+闪烁的目标行）: ${merged.items[0]?.code} [${merged.items[0]?.status}]`)
    }
  }

  // ── 4. page=2 切片正确性（组内 >20 条才有意义；不足则跳过）──
  for (const [key, group] of Object.entries(STATUS_GROUPS)) {
    const truth = all
      .filter((o) => group.statuses.includes(o.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    if (truth.length <= 20) { log(`\n  （${group.label} 组仅 ${truth.length} 条 ≤20，翻页切片跳过）`); continue }
    header(`${group.label} 组 page=2 翻页切片`)
    const p2 = await fetchGroupMerged(token, group, 2)
    assert(
      p2.items.map((o) => o.id).join() === truth.slice(20, 40).map((o) => o.id).join(),
      'page=2 切片 = 全量过滤第 21~40 条',
    )
  }

  // ── 5. 已完成（单状态卡）走普通单请求路径 ──
  header('已完成卡（COMPLETED 单状态，普通单请求路径）')
  const done = await api('GET', '/purchase-orders?page=1&limit=20&status=COMPLETED', { token })
  const doneResp = done.body?.data
  const doneTruth = all.filter((o) => o.status === 'COMPLETED')
  assert(doneResp?.items?.length === Math.min(20, doneTruth.length), `列表条数 ${doneResp?.items?.length} = 全量已完成数（≤20）`)
  assert(doneResp?.pagination?.total === doneTruth.length, `total=${doneResp?.pagination?.total} 与卡片数字 ${counts.COMPLETED} 一致`)
  if (doneResp?.items?.[0]) log(`  首条: ${doneResp.items[0].code} → 点击卡片后滚动定位目标`)

  // ── 6. 负向：非法状态值（防回归——statusFilter 组值只允许 PENDING/ACTIVE 前端拦）──
  header('负向：API 对非法 status 的表现（页面不会传，仅确认边界）')
  const bad = await api('GET', '/purchase-orders?limit=1&status=NOT_A_STATUS', { token })
  assert(bad.status >= 400, `非法 status 返回 ${bad.status}（页面组值由 fetchOrdersResp 展开为合法单状态，不会直传）`)
} catch (e) {
  failed++
  console.error('脚本异常:', e)
} finally {
  log(`\n━━━ 结果: ${passed} 通过 / ${failed} 失败 ━━━`)
  process.exit(failed > 0 ? 1 : 0)
}
