/**
 * P2-4 e2e 冒烟：文件矩阵（归档核对表）+ 归档拦截 + RESTRICTED 越权验证
 * 前置：主服务(:3000) + PG(pm_dev) 运行。
 *
 * 覆盖：
 *   1. GET /projects/:id/file-matrix —— summary / groups(矩阵) / rows(总表) / missing(缺项)
 *   2. POST /projects/:id/archive —— 拦截 400，errors[]={name,status,owner}（§7.7）
 *   3. RESTRICTED 越权：scopeRefs 仅含 A(孙若清)，A→200 可见/下载，B(马承志)→不可见/403
 *   4. visibleRequirementFilter 范围终审：scopeRefs.userIds 命中（A 非阶段负责人也可见）
 *
 * 测试数据在结束时清理（scopeRefs 还原、临时文件行删除）。
 */
import { PrismaClient, Prisma } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE || 'http://localhost:3000'
const prisma = new PrismaClient()

const PROJ = 'cmszmbz47007iu75c7mdm10rx' // DEMO25021
const PLC_REQ = 'cmszmbz5k00acu75cvtck8nq9' // PLC程序（REJECTED, RESTRICTED, PH05）
const CATALOG = 'cmszmbz5e00a2u75cg7zkxvx9' // PH05 目录
const A_EMAIL = 'sunruoqing@example.com' // 孙若清（MEMBER，PH05 阶段负责人）
const B_EMAIL = 'machengzhi@example.com' // 马承志（MEMBER，非任何阶段负责人）
const A_ID = 'cmszmbyyw001ku75cfq5gxvhz'

const log = (...a) => console.log(...a)
let step = 0
let passed = 0
let failed = 0
const header = (n) => log(`\n━━━ [${++step}] ${n} ━━━`)
function assert(cond, msg, extra) {
  if (cond) { passed++; log(`  ✓ ${msg}`) }
  else { failed++; log(`  ✗ ${msg}`, extra ?? '') }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: 'demo123456' } })
  return { status: r.status, token: r.body?.data?.token ?? '' }
}

const TEST_FILE_ID = 'p2-4-restricted-test-file'
const TEST_REL = `${PROJ}/${CATALOG}/p2-4-test.txt`
let freshReqId = null
let restoredScopeRefs = null

try {
  // 记录 PLC 原始 scopeRefs，便于还原
  const before = await prisma.fileRequirement.findUnique({ where: { id: PLC_REQ }, select: { scopeRefs: true, scope: true } })
  restoredScopeRefs = before.scopeRefs

  // ── 1. 登录三账号 ──
  header('登录 admin / A(孙若清) / B(马承志)')
  const admin = await login('chenmuzhi@example.com')
  assert(admin.status === 200 && admin.token, 'admin 登录成功')
  const a = await login(A_EMAIL)
  assert(a.status === 200 && a.token, 'A(孙若清) 登录成功')
  const b = await login(B_EMAIL)
  assert(b.status === 200 && b.token, 'B(马承志) 登录成功')

  // ── 2. file-matrix ──
  header('GET /projects/:id/file-matrix 文件矩阵')
  const matrix = await api('GET', `/projects/${PROJ}/file-matrix`, { token: admin.token })
  assert(matrix.status === 200 && matrix.body?.success, `file-matrix 200（实际 ${matrix.status}）`)
  const d = matrix.body?.data ?? {}
  assert(typeof d.summary?.total === 'number' && typeof d.summary?.approved === 'number', 'summary.total/approved 存在')
  assert(Array.isArray(d.groups) && d.groups.length > 0, `groups 矩阵非空（${d.groups?.length ?? 0} 组）`)
  const g0 = d.groups?.[0] ?? {}
  assert(typeof g0.counts?.approved === 'number' && typeof g0.counts?.rejected === 'number', 'group.counts 含 approved/rejected')
  assert(Array.isArray(d.rows) && d.rows.length === d.summary.total, `rows 总表行数 = total（${d.rows?.length}）`)
  const row0 = d.rows?.[0] ?? {}
  assert('versionCount' in row0 && 'catalogName' in row0 && 'phaseCode' in row0, 'row 含 versionCount/catalogName/phaseCode')
  assert(Array.isArray(d.missing), 'missing 数组存在')
  const plcMissing = d.missing?.find((m) => m.id === PLC_REQ)
  assert(plcMissing?.status === 'REJECTED', '缺项清单含 PLC程序(REJECTED)')

  // ── 3. 归档拦截 ──
  header('POST /projects/:id/archive 归档拦截（应 400）')
  const archive = await api('POST', `/projects/${PROJ}/archive`, { token: admin.token })
  assert(archive.status === 400, `归档被拦截 400（实际 ${archive.status}）`)
  assert(archive.body?.success === false, 'success=false')
  assert(archive.body?.message === '存在未通过的必需文件，无法归档', 'message 对齐 §7.7')
  const errs = archive.body?.errors ?? []
  assert(Array.isArray(errs) && errs.length > 0, `errors 数组非空（${errs.length} 项）`)
  const plcErr = errs.find((e) => e.name === 'PLC程序')
  assert(!!plcErr, 'errors 含 PLC程序')
  assert(plcErr && plcErr.status === 'REJECTED', 'PLC程序 status=REJECTED')
  assert(plcErr && typeof plcErr.owner === 'string', `owner 为姓名字符串（${plcErr?.owner}）`)
  const allShapeOk = errs.every((e) => typeof e.name === 'string' && typeof e.status === 'string' && (typeof e.owner === 'string' || e.owner === null))
  assert(allShapeOk, 'errors[] 结构 = {name,status,owner}')

  // ── 4. 设置 RESTRICTED scopeRefs 仅含 A ──
  header('PATCH PLC程序 scopeRefs={userIds:[A]}')
  const patch = await api('PATCH', `/file-requirements/${PLC_REQ}`, {
    token: admin.token,
    body: { scope: 'RESTRICTED', scopeRefs: { userIds: [A_ID], deptIds: [] } },
  })
  assert(patch.status === 200 && patch.body?.success, `PATCH scopeRefs 200（实际 ${patch.status}）`)

  // ── 5. 列表范围终审：A 可见 / B 不可见 ──
  header('GET /file-requirements 范围终审（A 可见 / B 不可见）')
  const listA = await api('GET', `/file-requirements?projectId=${PROJ}&limit=100`, { token: a.token })
  const listB = await api('GET', `/file-requirements?projectId=${PROJ}&limit=100`, { token: b.token })
  const idsA = (listA.body?.data?.items ?? []).map((x) => x.id)
  const idsB = (listB.body?.data?.items ?? []).map((x) => x.id)
  assert(listA.status === 200 && idsA.includes(PLC_REQ), 'A 列表可见 PLC程序')
  assert(listB.status === 200 && !idsB.includes(PLC_REQ), 'B 列表不可见 PLC程序（范围终审正确）')

  // ── 6. 下载越权：A→200 / B→403 ──
  header('下载越权（A→200 / B→403）')
  const absPath = path.join(process.cwd(), 'uploads', TEST_REL)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, 'P2-4 RESTRICTED 越权测试文件内容\n')
  await prisma.file.upsert({
    where: { id: TEST_FILE_ID },
    update: {},
    create: {
      id: TEST_FILE_ID,
      requirementId: PLC_REQ,
      projectId: PROJ,
      name: 'P2-4 测试文件 v1.0',
      originalName: 'p2-4-test.txt',
      storagePath: TEST_REL,
      size: fs.statSync(absPath).size,
      mimeType: 'text/plain',
      version: 99,
      uploadedById: A_ID,
    },
  })
  const dlA = await api('GET', `/files/${TEST_FILE_ID}/download`, { token: a.token })
  assert(dlA.status === 200, `A 下载 200（实际 ${dlA.status}）`)
  const dlB = await api('GET', `/files/${TEST_FILE_ID}/download`, { token: b.token })
  assert(dlB.status === 403, `B 下载 403（实际 ${dlB.status}）`)

  // ── 7. visibleRequirementFilter：scopeRefs.userIds 命中（A 非阶段负责人）──
  header('scopeRefs.userIds 独立生效（A 非阶段负责人的条目也可见）')
  const ph17 = await prisma.phase.findFirst({ where: { projectId: PROJ, code: 'PH17' }, select: { id: true, ownerId: true } })
  const fresh = await api('POST', `/file-requirements`, {
    token: admin.token,
    body: {
      projectId: PROJ,
      catalogId: CATALOG,
      name: 'P2-4-RESTRICTED-越权测试条目',
      code: 'P2-4-TEST-001',
      phaseCode: 'PH17', // 阶段负责人=何雨桐（非 A）
      scope: 'RESTRICTED',
      scopeRefs: { userIds: [A_ID], deptIds: [] },
      required: false,
      ownerId: A_ID,
    },
  })
  freshReqId = fresh.body?.data?.id ?? null
  assert(fresh.status === 201 && !!freshReqId, `建 RESTRICTED 测试条目（${fresh.status}）`)
  const flA = await api('GET', `/file-requirements?projectId=${PROJ}&limit=100`, { token: a.token })
  const flB = await api('GET', `/file-requirements?projectId=${PROJ}&limit=100`, { token: b.token })
  const fIdsA = (flA.body?.data?.items ?? []).map((x) => x.id)
  const fIdsB = (flB.body?.data?.items ?? []).map((x) => x.id)
  assert(fIdsA.includes(freshReqId), 'A 可见（scopeRefs.userIds 命中，非阶段负责人）')
  assert(!fIdsB.includes(freshReqId), 'B 不可见（不在 scopeRefs）')

  // 纯 scopeRefs 下载授权：fresh 条目 phaseCode=PH17（负责人=何雨桐，非 A），
  // A 的下载权只能来自 scopeRefs.userIds 命中
  header('纯 scopeRefs 下载越权（A 非阶段负责人 → 200 / B → 403）')
  const FRESH_REL = `${PROJ}/${CATALOG}/p2-4-fresh.txt`
  const freshAbs = path.join(process.cwd(), 'uploads', FRESH_REL)
  fs.mkdirSync(path.dirname(freshAbs), { recursive: true })
  fs.writeFileSync(freshAbs, 'P2-4 scopeRefs 下载授权测试\n')
  await prisma.file.upsert({
    where: { id: 'p2-4-fresh-file' },
    update: {},
    create: {
      id: 'p2-4-fresh-file',
      requirementId: freshReqId,
      projectId: PROJ,
      name: 'P2-4 fresh v1.0',
      originalName: 'p2-4-fresh.txt',
      storagePath: FRESH_REL,
      size: fs.statSync(freshAbs).size,
      mimeType: 'text/plain',
      version: 1,
      uploadedById: A_ID,
    },
  })
  const dlFA = await api('GET', `/files/p2-4-fresh-file/download`, { token: a.token })
  assert(dlFA.status === 200, `A 下载（scopeRefs 授权，非阶段负责人）200（实际 ${dlFA.status}）`)
  const dlFB = await api('GET', `/files/p2-4-fresh-file/download`, { token: b.token })
  assert(dlFB.status === 403, `B 下载 403（实际 ${dlFB.status}）`)

  log(`\n════════ 结果：${passed} 通过 / ${failed} 失败 ════════`)
} catch (e) {
  failed++
  log('  ✗ 脚本异常：', e)
} finally {
  // ── 清理 ──
  try {
    if (freshReqId) await prisma.fileRequirement.delete({ where: { id: freshReqId } }).catch(() => {})
    await prisma.file.delete({ where: { id: TEST_FILE_ID } }).catch(() => {})
    await prisma.file.delete({ where: { id: 'p2-4-fresh-file' } }).catch(() => {})
    const absPath = path.join(process.cwd(), 'uploads', TEST_REL)
    const freshAbs = path.join(process.cwd(), 'uploads', `${PROJ}/${CATALOG}/p2-4-fresh.txt`)
    fs.rmSync(absPath, { force: true })
    fs.rmSync(freshAbs, { force: true })
    await prisma.fileRequirement.update({
      where: { id: PLC_REQ },
      data: { scopeRefs: restoredScopeRefs === null ? Prisma.JsonNull : restoredScopeRefs ?? undefined },
    })
    log('\n[cleanup] 测试数据已清理（scopeRefs 还原、临时文件行删除）')
  } catch (e) {
    log('[cleanup] 清理异常：', e.message)
  }
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}
