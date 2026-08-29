/**
 * P2-1 e2e 冒烟：目录树 CRUD + 条目 CRUD + 筛选 + Excel 导入(dryRun)
 * 前置：主服务(:3000) + PG(pm_dev) 运行。
 */
import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'

const BASE = process.env.E2E_BASE || 'http://localhost:3000'
const prisma = new PrismaClient()

const log = (...a) => console.log(...a)
let step = 0
let passed = 0, failed = 0
const header = (n) => log(`\n━━━ [${++step}] ${n} ━━━`)
function assert(cond, msg, extra) {
  if (cond) { passed++; log(`  ✓ ${msg}`) }
  else { failed++; log(`  ✗ ${msg}`, extra ?? '') }
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

const PROJ = 'cmszmbz47007iu75c7mdm10rx' // DEMO25021
let token = ''
let createdCatalogId = ''
let createdReqId = ''

try {
  // 1. 登录 chenmuzhi
  header('登录 chenmuzhi (ADMIN)')
  const login = await api('POST', '/auth/login', { body: { email: 'chenmuzhi@example.com', password: 'demo123456' } })
  assert(login.status === 200 && login.body?.success, '登录成功')
  token = login.body?.data?.token ?? ''
  assert(!!token, '拿到 token')

  // 2. GET 目录树
  header('GET /projects/:id/catalogs 目录树')
  const cat = await api('GET', `/projects/${PROJ}/catalogs`, { token })
  assert(cat.status === 200 && cat.body?.success, '目录树 200')
  assert(Array.isArray(cat.body?.data?.items), '返回 items 数组')
  const rootCount = cat.body?.data?.items?.length ?? 0
  assert(rootCount > 0, `根目录数 > 0（实际 ${rootCount}）`)
  const aNode = cat.body?.data?.items?.find((n) => n.requirementCount > 0)
  assert(!!aNode, `有目录含条目计数 > 0`)
  assert(typeof cat.body?.data?.can?.create === 'boolean', 'can.create 为布尔')

  // 3. POST 建根目录
  header('POST 新建目录')
  const mk = await api('POST', `/projects/${PROJ}/catalogs`, { token, body: { name: 'P2-1-冒烟目录', remark: 'smoke' } })
  assert(mk.status === 201 && mk.body?.success, `新建目录 201（实际 ${mk.status}）`)
  createdCatalogId = mk.body?.data?.id ?? ''
  assert(!!createdCatalogId, '拿到新目录 id')

  // 4. PATCH 重命名
  header('PATCH 重命名目录')
  const up = await api('PATCH', `/projects/${PROJ}/catalogs`, { token, body: { id: createdCatalogId, name: 'P2-1-冒烟目录-改' } })
  assert(up.status === 200 && up.body?.success, '重命名 200')

  // 5. POST 建条目
  header('POST 手动建条目')
  const mkReq = await api('POST', '/file-requirements', { token, body: { projectId: PROJ, catalogId: createdCatalogId, name: '冒烟测试图纸', code: 'SMOKE-001', purpose: '报审', scope: 'PUBLIC', required: true } })
  assert(mkReq.status === 201 && mkReq.body?.success, `建条目 201（实际 ${mkReq.status}）`)
  createdReqId = mkReq.body?.data?.id ?? ''
  assert(!!createdReqId, '拿到条目 id')

  // 6. GET 条目列表（目录过滤）
  header('GET /file-requirements 列表（目录过滤）')
  const list = await api('GET', `/file-requirements?projectId=${PROJ}&catalogId=${createdCatalogId}`, { token })
  assert(list.status === 200 && list.body?.success, '列表 200')
  const items = list.body?.data?.items ?? []
  assert(items.length === 1 && items[0].id === createdReqId, `目录过滤命中 1 条（实际 ${items.length}）`)
  assert(items[0]?.permissions && typeof items[0].permissions.edit === 'boolean', '条目含 permissions.edit')
  assert(list.body?.data?.pagination?.total >= 1, '分页 total 正常')
  assert(list.body?.data?.can?.create === true, 'can.create=true（ADMIN）')

  // 7. 筛选：mine / status
  header('筛选：mine=1 / status=WAITING')
  const mine = await api('GET', `/file-requirements?projectId=${PROJ}&mine=1`, { token })
  assert(mine.status === 200, 'mine 筛选 200')
  assert((mine.body?.data?.items ?? []).every((i) => i.ownerId === 'cmszmbyyo001du75coql6c6ko' || i.ownerId === null), 'mine 只含本人(或空)条目')
  const st = await api('GET', `/file-requirements?projectId=${PROJ}&status=WAITING`, { token })
  assert(st.status === 200 && (st.body?.data?.items ?? []).every((i) => i.status === 'WAITING'), 'status 筛选生效')

  // 8. PATCH 改条目
  header('PATCH 改条目属性')
  const upReq = await api('PATCH', `/file-requirements/${createdReqId}`, { token, body: { purpose: '存档', scope: 'RESTRICTED' } })
  assert(upReq.status === 200 && upReq.body?.success, '改属性 200')

  // 9. DELETE 非空目录 → 400
  header('DELETE 非空目录（应 400）')
  const del = await api('DELETE', `/projects/${PROJ}/catalogs?catalogId=${createdCatalogId}`, { token })
  assert(del.status === 400, `非空目录删除 400（实际 ${del.status}）`)

  // 10. Excel 导入 dryRun
  header('POST /file-requirements/import dryRun')
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['文件名称', '文件编号', '目录', '阶段', '责任人', '外部提供方', '用途', '开放范围', '截止日期', '必需', '备注'],
    ['导入测试文件A', 'IMP-001', 'P2-1-冒烟目录-改', 'PH05', '', '', '报审', '公开', '', '是', ''],
  ])
  XLSX.utils.book_append_sheet(wb, ws, '文件条目')
  const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const fd = new FormData()
  fd.append('projectId', PROJ)
  fd.append('file', new Blob([new Uint8Array(xbuf)]), 'file-requirements.xlsx')
  fd.append('dryRun', '1')
  const impRes = await fetch(`${BASE}/api/file-requirements/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  const imp = await impRes.json()
  assert(impRes.status === 200 && imp.success, `import dryRun 200（实际 ${impRes.status}）`)
  assert(imp.data?.dryRun === true && imp.data?.wouldCreate === 1, `wouldCreate=1（实际 ${imp.data?.wouldCreate}）`)
  assert(Array.isArray(imp.data?.errors) && imp.data.errors.length === 0, '无错误行')

  // 11. 归档矩阵
  header('GET /projects/:id/file-matrix')
  const matrix = await api('GET', `/projects/${PROJ}/file-matrix`, { token })
  assert(matrix.status === 200 && matrix.body?.success, 'file-matrix 200')
  assert(typeof matrix.body?.data?.summary?.total === 'number', 'summary.total 正常')
  assert(Array.isArray(matrix.body?.data?.missing), 'missing 数组存在')
} catch (e) {
  log('  ✗ 异常：', e.message)
  failed++
} finally {
  // 清理：删除本次创建的条目 + 目录
  try {
    if (createdReqId) await prisma.fileRequirement.deleteMany({ where: { id: createdReqId } })
    if (createdCatalogId) await prisma.fileCatalog.deleteMany({ where: { id: createdCatalogId } })
    log('\n清理完成')
  } catch (e) { log('清理失败：', e.message) }
  await prisma.$disconnect()
  log(`\n════════ 结果：${passed} 通过 / ${failed} 失败 ════════`)
  process.exit(failed > 0 ? 1 : 0)
}
