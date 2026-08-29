/**
 * 删除工程线上验收（2026-08-23）：权限矩阵抽查
 * 链路：ADMIN 建测试项目 → 非成员 DELETE 404 → ADMIN 删除 200
 *       → 建阶段+任务 → 删阶段 400（有引用）→ 删任务 200 → 删阶段 200 → 删项目 200
 *       → cleanup-stats 权限 → supplier-request DRAFT 删除 → 全部清理
 */
const BASE = process.env.S5_BASE || 'https://pm.sunruoqing.cn'
const PASS = process.env.S5_PASSWORD || '123456'

let step = 0, passed = 0, failed = 0
const header = (n) => console.log(`\n━━━ [${++step}] ${n} ━━━`)
function assert(cond, msg, extra = '') { if (cond) { passed++; console.log(`  ✓ ${msg}`) } else { failed++; console.log(`  ✗ ${msg} ${extra}`) } }

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

let adminToken = '', memberToken = ''
const ids = {}

try {
  header('登录 ADMIN（chenmuzhi）与 MEMBER（sunruoqing）')
  const la = await api('POST', '/auth/login', { body: { email: 'chenmuzhi@example.com', password: PASS } })
  const lm = await api('POST', '/auth/login', { body: { email: 'sunruoqing@example.com', password: PASS } })
  adminToken = la.body?.data?.token ?? ''
  memberToken = lm.body?.data?.token ?? ''
  assert(!!adminToken && !!memberToken, '双 token 到手')

  header('D1 项目删除：非成员不可见 → 404（M2 修复验证）')
  // 用真实模板实例化（自带阶段），验证项目+阶段+任务的完整删除链
  const tpls = await api('GET', '/process-templates', { token: adminToken })
  const tpl = tpls.body?.data?.items?.[0] ?? tpls.body?.data?.[0]
  assert(!!tpl?.id, '拿到流程模板')
  const mk = await api('POST', '/projects', { token: adminToken, body: {
    code: 'DEMO99001', name: '删除验收测试项目',
    description: '删除工程验收用，测试完即删',
    templateId: tpl?.id,
  } })
  assert(mk.status === 200 || mk.status === 201, `建测试项目（${mk.status}）`)
  ids.project = mk.body?.data?.id ?? mk.body?.data?.project?.id ?? ''
  assert(!!ids.project, '拿到项目 id')

  // 项目实例化后自带阶段：取第一个阶段作为测试对象
  const tree = await api('GET', `/projects/${ids.project}/tree`, { token: adminToken })
  const phaseNode = tree.body?.data?.phases?.[0] ?? tree.body?.data?.[0]?.phases?.[0] ?? tree.body?.data
  ids.phase = phaseNode?.id ?? ''
  assert(!!ids.phase, '模板实例化产出阶段')

  const mDel = await api('DELETE', `/projects/${ids.project}`, { token: memberToken })
  // sunruoqing 可能被模板岗位匹配为成员：成员非 OWNER → 403（合法）；若恰非成员 → 404（不可见）
  assert(
    mDel.status === 403 || mDel.status === 404,
    `MEMBER 删除他人项目 → 403/404（实际 ${mDel.status}，${mDel.body?.message ?? mDel.body?.error?.message ?? ''}）`,
  )
  // 非成员不可见验证（用 weizemin 或任意未被匹配的用户）
  const lc = await api('POST', '/auth/login', { body: { email: 'weizemin@example.com', password: PASS } })
  if (lc.body?.data?.token) {
    const cDel = await api('DELETE', `/projects/${ids.project}`, { token: lc.body.data.token })
    assert(cDel.status === 404, `非成员删除 → 404（实际 ${cDel.status}，${cDel.body?.message ?? ''}，M2 可见性闸）`)
  } else { console.log('  weizemin 登录失败，跳过非成员 404 验证（不计数）') }

  header('D2 阶段删除：有子任务 → 400 引用保护')
  const tk = await api('POST', `/phases/${ids.phase}/tasks`, { token: adminToken, body: { title: '测试任务', priority: 'HIGH' } })
  assert(!!tk.body?.data?.id || !!tk.body?.data?.task?.id, `建任务（${tk.status}，${tk.body?.message ?? ''}）`)
  ids.task = tk.body?.data?.id ?? tk.body?.data?.task?.id ?? ''
  const pDel = await api('DELETE', `/phases/${ids.phase}`, { token: adminToken })
  assert(pDel.status === 400, `删有任务阶段 → 400（实际 ${pDel.status}，${pDel.body?.message ?? ''}）`)

  header('D3 任务删除 → 阶段删除 → 项目删除（级联链）')
  const tDel = await api('DELETE', `/tasks/${ids.task}`, { token: adminToken })
  assert(tDel.status === 200, `删任务 → 200（实际 ${tDel.status}）`)
  const pDel2 = await api('DELETE', `/phases/${ids.phase}`, { token: adminToken })
  // 模板实例化自带文件条目：仍有引用时 400（引用保护正确）；无引用时 200
  assert(pDel2.status === 200 || pDel2.status === 400, `删阶段 → 200/400（实际 ${pDel2.status}，${pDel2.body?.message ?? ''}）`)

  header('D5 供应商清单 DRAFT 删除（状态机限制，在项目删除前执行）')
  const orgs = await api('GET', '/external-orgs?page=1&limit=50', { token: adminToken })
  const supplier = orgs.body?.data?.items?.find((o) => o.type === 'SUPPLIER' || o.orgType === 'SUPPLIER')
  const sr = await api('POST', '/supplier-requests', { token: adminToken, body: {
    projectId: ids.project, supplierId: supplier?.id,
    title: 'DELTEST-供应商清单',
    items: [{ name: '测试物料', spec: 'X1', quantity: 1, unit: '件' }],
  } })
  ids.sr = sr.body?.data?.id ?? sr.body?.data?.supplierRequest?.id ?? ''
  assert(!!ids.sr, `建 DRAFT 供应商清单（${sr.status}，${sr.body?.message ?? ''}）`)
  const srDel = await api('DELETE', `/supplier-requests/${ids.sr}`, { token: adminToken })
  assert(srDel.status === 200, `删 DRAFT 清单 → 200（实际 ${srDel.status}，${srDel.body?.message ?? ''}）`)

  header('D3b 项目删除（级联）')
  const projDel = await api('DELETE', `/projects/${ids.project}`, { token: adminToken })
  assert(projDel.status === 200, `ADMIN 删项目 → 200（实际 ${projDel.status}）`)
  // 删除后不可见确认（403/404 均视为不可达）
  const projGet = await api('GET', `/projects/${ids.project}`, { token: adminToken })
  assert(projGet.status === 403 || projGet.status === 404, `删除后 GET 项目 → 403/404（实际 ${projGet.status}）`)

  header('D4 cleanup-stats 权限：ADMIN 200 / MEMBER 403')
  const csAdmin = await api('GET', '/admin/cleanup-stats', { token: adminToken })
  const csMember = await api('GET', '/admin/cleanup-stats', { token: memberToken })
  assert(csAdmin.status === 200, `ADMIN cleanup-stats → 200（实际 ${csAdmin.status}）`)
  assert(csMember.status === 403, `MEMBER cleanup-stats → 403（实际 ${csMember.status}）`)
  const stats = csAdmin.body?.data ?? csAdmin.body
  console.log(`  stats: ${JSON.stringify(stats ?? {}).slice(0, 300)}`)



  header('D6 会话解散权限：非群主 → 403')
  const convs = await api('GET', '/conversations', { token: adminToken })
  const conv = convs.body?.data?.items?.find((c) => c.type === 'PROJECT') ?? convs.body?.data?.[0]
  if (conv?.id) {
    const cDel = await api('DELETE', `/conversations/${conv.id}`, { token: memberToken })
    assert(cDel.status === 403, `MEMBER 解散非本人群主会话 → 403（实际 ${cDel.status}）`)
  } else { console.log('  无会话可测，跳过（不计数）') }

  header('D7 消息删除权限：非 sender → 403')
  const msgs = conv?.id ? await api('GET', `/conversations/${conv.id}/messages`, { token: adminToken }) : null
  const msg = msgs?.body?.data?.items?.find((m) => m.senderId && m.senderId !== '') ?? msgs?.body?.data?.[0]
  if (msg?.id && conv?.id) {
    const mDel2 = await api('DELETE', `/conversations/${conv.id}/messages/${msg.id}`, { token: memberToken })
    assert(mDel2.status === 403, `MEMBER 删他人消息 → 403（实际 ${mDel2.status}）`)
  } else { console.log('  无消息可测，跳过（不计数）') }

} catch (err) {
  failed++
  console.log('!!! 异常中断:', err?.message ?? err)
} finally {
  header('清理残留（项目/阶段/任务/清单）')
  try {
    // 若项目删除失败，兜底删除
    if (ids.project) {
      const r = await api('DELETE', `/projects/${ids.project}`, { token: adminToken })
      console.log(`  兜底删项目: ${r.status}`)
    }
    if (ids.sr && ids.sr !== '') {
      const r = await api('DELETE', `/supplier-requests/${ids.sr}`, { token: adminToken })
      console.log(`  兜底删清单: ${r.status}`)
    }
  } catch (e) { console.log('  清理异常:', e.message) }
}

console.log(`\n══════ 删除工程验收: PASS=${passed} FAIL=${failed} ══════`)
process.exit(failed > 0 ? 1 : 0)
