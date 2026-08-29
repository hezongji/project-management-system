#!/usr/bin/env node
/**
 * QA B2a-1 —— 组织链 e2e 回归（自建自删闭环，可重复执行的回归资产）
 *
 * 用法:
 *   node scripts/qa/b2-org-chain.mjs                              # 默认打线上 https://pm.hezongji.cn/api
 *   BASE=http://127.0.0.1:3001/api node scripts/qa/b2-org-chain.mjs
 *
 * 认证: 参照 scripts/e2e-full.mjs —— 读 /opt/pm-app/.env 的 JWT_SECRET，
 *       以 ADMIN（chenmuzhi）签 Bearer token。
 * 链路: POST /departments 建部门 → GET 树断言
 *       → POST /job-titles 建岗位（deptHint 关联部门）→ GET 断言
 *       → GET /external-orgs?type=SUPPLIER 看现有字段 → POST 建外部主体(QA-B2-供应商)
 *       → POST /external-orgs/:id/contacts 建联系人（含邮箱格式 400 负例）→ GET 断言
 *       → GET /admin/users 200+分页 → 自建测试用户
 *         → POST /admin/users/reset-password（仅对自建测试用户执行；改密会破坏真实用户登录）
 *         → GET /admin/permissions/:userId（只读探测）
 *       → 清理: DELETE 联系人 → 外部主体 → 岗位 → 测试用户 → 部门（用户须先于部门删，
 *         否则部门非空 400）→ 残留验证。
 * 数据: 全部 QA-B2- 前缀；开跑前先清残留（脚本中断后可幂等重跑）。
 * 退出码: 0 = 无 FAIL；1 = 有 FAIL / 残留；2 = 环境错误（.env 缺失等）。
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
const ENV_PATH = '/opt/pm-app/.env'

// ── 认证（参照 scripts/e2e-full.mjs / smoke-pages.mjs）──────────────────────
const envText = (() => {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8')
  } catch {
    console.error(`FATAL: 无法读取 ${ENV_PATH}`)
    process.exit(2)
  }
})()
const envGet = (k) =>
  envText.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)?.trim()
const JWT_SECRET = envGet('JWT_SECRET')
if (!JWT_SECRET) {
  console.error('FATAL: .env 缺少 JWT_SECRET')
  process.exit(2)
}
const ADMIN = {
  userId: 'cmt7cdbzv001ov55otclrv94t',
  email: 'chenmuzhi@example.com',
  role: 'ADMIN',
}
const token = jwt.sign(ADMIN, JWT_SECRET, { expiresIn: '1h' })
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ── 计数与断言 ───────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
let skip = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const skipCheck = (name, reason) => {
  console.log(`⏭️ SKIP  ${name}  → ${reason}`)
  skip++
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const api = async (method, path, body, timeoutMs = 30000) => {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: H,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 忽略 */
    }
    return { status: res.status, json }
  } catch (e) {
    return { status: 0, json: null, error: e?.name === 'AbortError' ? '请求超时(30s)' : String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

// ── 常量 ────────────────────────────────────────────────────────────────────
const DEPT = 'QA-B2-测试部'
const TITLE = 'QA-B2-测试岗'
const ORG = 'QA-B2-供应商'
const CONTACT = 'QA-B2-联系人'
const USER_NAME = 'QA-B2-测试用户'
const USER_EMAIL = `qa-b2-${Date.now()}@qa.local`
const PREFIX = 'QA-B2-'

/** 部门树递归找节点 */
const findDept = (nodes, id) => {
  for (const n of nodes ?? []) {
    if (n.id === id) return n
    const hit = findDept(n.children, id)
    if (hit) return hit
  }
  return null
}
/** 部门树拍平 */
const flatDept = (nodes, acc = []) => {
  for (const n of nodes ?? []) {
    acc.push(n)
    flatDept(n.children, acc)
  }
  return acc
}

// ── 残留清理（幂等重跑保障）─────────────────────────────────────────────────
async function preClean() {
  console.log(`\n🧹 预清理残留（${PREFIX}* 前缀，无则跳过）`)
  // 用户（须先删，部门非空校验依赖）
  const users = await api('GET', `/admin/users?q=${encodeURIComponent(PREFIX)}&limit=100`)
  for (const u of users.json?.data?.items ?? []) {
    if ((u.name ?? '').startsWith(PREFIX)) {
      const r = await api('DELETE', `/admin/users/${u.id}`)
      console.log(`  残留用户 ${u.name}: DELETE ${r.status}`)
    }
  }
  // 外部主体（DELETE 级联删联系人）
  const orgs = await api('GET', `/external-orgs?q=${encodeURIComponent(PREFIX)}`)
  for (const o of orgs.json?.data?.items ?? []) {
    if ((o.name ?? '').startsWith(PREFIX)) {
      const r = await api('DELETE', `/external-orgs/${o.id}`)
      console.log(`  残留主体 ${o.name}: DELETE ${r.status}`)
    }
  }
  // 岗位
  const titles = await api('GET', '/job-titles?limit=100')
  for (const t of titles.json?.data?.items ?? []) {
    if ((t.name ?? '').startsWith(PREFIX)) {
      const r = await api('DELETE', `/job-titles/${t.id}`)
      console.log(`  残留岗位 ${t.name}: DELETE ${r.status}`)
    }
  }
  // 部门（子部门先删：按深度倒序）
  const depts = await api('GET', '/departments')
  const flat = flatDept(depts.json?.data?.items ?? [])
    .filter((d) => (d.name ?? '').startsWith(PREFIX))
    .sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0))
  for (const d of flat) {
    const r = await api('DELETE', `/departments/${d.id}`)
    console.log(`  残留部门 ${d.name}: DELETE ${r.status}`)
  }
}

// ── 主链路 ──────────────────────────────────────────────────────────────────
const ids = { dept: null, title: null, org: null, contact: null, user: null }

async function main() {
  console.log(`\n━━━ 1/5 部门：POST /departments → GET 树断言 ━━━`)
  const deptRes = await api('POST', '/departments', { name: DEPT, sort: 99 })
  check('POST /departments 建部门', deptRes.status === 201, `status=${deptRes.status} ${deptRes.json?.message ?? deptRes.error ?? ''}`)
  ids.dept = deptRes.json?.data?.id ?? null
  check('  返回 id + name 透传', !!ids.dept && deptRes.json?.data?.name === DEPT)

  const deptTree = await api('GET', '/departments')
  const node = findDept(deptTree.json?.data?.items ?? [], ids.dept)
  check(
    'GET /departments 树含新部门',
    deptTree.status === 200 && !!node,
    node ? `name=${node.name} memberCount=${node.memberCount} children=${node.children?.length ?? 0}` : '树中未找到',
  )
  check('  新部门 memberCount=0（空部门可删）', node?.memberCount === 0)

  console.log(`\n━━━ 2/5 岗位：POST /job-titles（deptHint 关联部门）→ GET 断言 ━━━`)
  const titleRes = await api('POST', '/job-titles', { name: TITLE, deptHint: DEPT, sort: 99 })
  check('POST /job-titles 建岗位', titleRes.status === 201, `status=${titleRes.status} ${titleRes.json?.message ?? titleRes.error ?? ''}`)
  ids.title = titleRes.json?.data?.id ?? null
  check('  返回 id + deptHint 关联部门', !!ids.title && titleRes.json?.data?.deptHint === DEPT)

  const titles = await api('GET', '/job-titles?limit=100')
  const tRow = (titles.json?.data?.items ?? []).find((t) => t.id === ids.title)
  check(
    'GET /job-titles 含新岗位',
    titles.status === 200 && !!tRow,
    tRow ? `name=${tRow.name} userCount=${tRow.userCount} stageCount=${tRow.stageCount}` : '列表中未找到',
  )
  check('  新岗位 userCount=0（无引用可删）', tRow?.userCount === 0)

  console.log(`\n━━━ 3/5 外部主体：GET 现有 SUPPLIER 看字段 → POST 建主体 ━━━`)
  const existOrgs = await api('GET', '/external-orgs?type=SUPPLIER&limit=3')
  const existSample = (existOrgs.json?.data?.items ?? [])[0]
  check('GET /external-orgs?type=SUPPLIER 200+分页', existOrgs.status === 200 && Array.isArray(existOrgs.json?.data?.items), `total=${existOrgs.json?.data?.pagination?.total ?? '?'}`)
  console.log(
    `  现有 SUPPLIER 字段样本: ${existSample ? Object.keys(existSample).join(',') : '（库中暂无 SUPPLIER，按 schema 枚举 type=SUPPLIER 构造）'}`,
  )

  const orgRes = await api('POST', '/external-orgs', {
    name: ORG,
    type: 'SUPPLIER',
    phone: '13800000000',
    remark: 'QA-B2 自建自删测试主体',
  })
  check('POST /external-orgs 建外部主体(SUPPLIER)', orgRes.status === 201, `status=${orgRes.status} ${orgRes.json?.message ?? orgRes.error ?? ''}`)
  ids.org = orgRes.json?.data?.id ?? null
  check('  返回 id + type/isActive 透传', !!ids.org && orgRes.json?.data?.type === 'SUPPLIER' && orgRes.json?.data?.isActive === true)

  const orgSearch = await api('GET', `/external-orgs?q=${encodeURIComponent(PREFIX)}`)
  const orgRow = (orgSearch.json?.data?.items ?? []).find((o) => o.id === ids.org)
  check('GET /external-orgs?q=QA-B2- 搜索命中', orgSearch.status === 200 && !!orgRow, orgRow ? `contacts=${orgRow._count?.contacts ?? orgRow.contacts?.length ?? 0}` : '未命中')

  console.log(`\n━━━ 4/5 联系人：POST contacts（含 400 负例）→ GET 断言 ━━━`)
  const contactRes = await api('POST', `/external-orgs/${ids.org}/contacts`, {
    name: CONTACT,
    title: '商务对接',
    phone: '13900000000',
    email: 'qa-b2@qa.local',
  })
  check('POST contacts 建联系人', contactRes.status === 201, `status=${contactRes.status} ${contactRes.json?.message ?? contactRes.error ?? ''}`)
  ids.contact = contactRes.json?.data?.id ?? null
  check('  返回 id + orgId 归属正确', !!ids.contact && contactRes.json?.data?.orgId === ids.org)

  const badEmail = await api('POST', `/external-orgs/${ids.org}/contacts`, {
    name: CONTACT,
    email: 'not-an-email',
  })
  check('POST contacts 非法邮箱 → 400（业务校验）', badEmail.status === 400, `status=${badEmail.status} ${badEmail.json?.message ?? ''}`)

  const contacts = await api('GET', `/external-orgs/${ids.org}/contacts`)
  const cRow = (contacts.json?.data?.items ?? []).find((c) => c.id === ids.contact)
  check(
    'GET contacts 列表含新联系人',
    contacts.status === 200 && !!cRow,
    cRow ? `name=${cRow.name} title=${cRow.title} email=${cRow.email}` : '列表中未找到',
  )

  console.log(`\n━━━ 5/5 admin 用户管理：GET 分页 → 自建用户 → reset-password / permissions ━━━`)
  const users1 = await api('GET', '/admin/users?page=1&limit=2')
  const pg = users1.json?.data?.pagination
  check(
    'GET /admin/users 200+分页元信息',
    users1.status === 200 && Array.isArray(users1.json?.data?.items) && pg?.page === 1 && typeof pg?.total === 'number' && typeof pg?.pages === 'number',
    `page=${pg?.page} limit=${pg?.limit} total=${pg?.total} pages=${pg?.pages}`,
  )
  check('  limit=2 分页生效（items≤2）', (users1.json?.data?.items ?? []).length <= 2)

  // 自建测试用户（挂到自建部门，形成 部门↔用户 关联断言）
  const userRes = await api('POST', '/admin/users', {
    name: USER_NAME,
    email: USER_EMAIL,
    password: 'QaB2-Init-123',
    role: 'MEMBER',
    departmentId: ids.dept,
  })
  ids.user = userRes.json?.data?.id ?? null
  check('POST /admin/users 自建测试用户', userRes.status === 201, `status=${userRes.status} ${userRes.json?.message ?? userRes.error ?? ''}`)
  check('  归属自建部门 departmentName 透传', !!ids.user && userRes.json?.data?.departmentName === DEPT, `got=${userRes.json?.data?.departmentName ?? '无'}`)

  // reset-password：destructive —— 仅对自建测试用户执行；创建失败则 SKIP 并打印原因
  if (ids.user) {
    const rst = await api('POST', '/admin/users/reset-password', {
      userId: ids.user,
      newPassword: 'QaB2-Rst-456',
    })
    check(
      'POST /admin/users/reset-password（仅自建用户）',
      rst.status === 200 && rst.json?.data?.id === ids.user,
      `status=${rst.status} msg=${rst.json?.message ?? ''}`,
    )
    const perms = await api('GET', `/admin/permissions/${ids.user}`)
    check(
      'GET /admin/permissions/:userId（只读探测）',
      perms.status === 200 && perms.json?.data?.user?.id === ids.user,
      `status=${perms.status} pagePermissions=${JSON.stringify(perms.json?.data?.pagePermissions ?? null)}`,
    )
  } else {
    skipCheck('POST /admin/users/reset-password', '无自建测试用户（创建失败，跳过 destructive 探测以免影响真实用户）')
    skipCheck('GET /admin/permissions/:userId', '无自建测试用户')
  }
}

// ── 清理（finally 兜底：联系人→主体→岗位→用户→部门）────────────────────────
async function cleanup() {
  console.log(`\n━━━ 清理：DELETE 联系人 → 主体 → 岗位 → 测试用户 → 部门 ━━━`)
  if (ids.contact) {
    const r = await api('DELETE', `/external-orgs/${ids.org}/contacts/${ids.contact}`)
    check('DELETE 联系人', r.status === 200, `status=${r.status} ${r.json?.message ?? ''}`)
  }
  if (ids.org) {
    const r = await api('DELETE', `/external-orgs/${ids.org}`)
    check('DELETE 外部主体（级联联系人兜底）', r.status === 200, `status=${r.status} ${r.json?.message ?? ''}`)
  }
  if (ids.title) {
    const r = await api('DELETE', `/job-titles/${ids.title}`)
    check('DELETE 岗位', r.status === 200, `status=${r.status} ${r.json?.message ?? ''}`)
  }
  if (ids.user) {
    const r = await api('DELETE', `/admin/users/${ids.user}`)
    check('DELETE 自建测试用户', r.status === 200, `status=${r.status} ${r.json?.message ?? ''}`)
  }
  if (ids.dept) {
    const r = await api('DELETE', `/departments/${ids.dept}`)
    check('DELETE 部门', r.status === 200, `status=${r.status} ${r.json?.message ?? ''}`)
  }
}

// ── 残留验证（清理彻底性）───────────────────────────────────────────────────
async function verifyClean() {
  console.log(`\n━━━ 残留验证（QA-B2-* 应全部消失）━━━`)
  const depts = await api('GET', '/departments')
  const deptLeft = flatDept(depts.json?.data?.items ?? []).filter((d) => (d.name ?? '').startsWith(PREFIX))
  check('部门无残留', deptLeft.length === 0, deptLeft.map((d) => d.name).join(',') || '已清空')

  const titles = await api('GET', '/job-titles?limit=100')
  const titleLeft = (titles.json?.data?.items ?? []).filter((t) => (t.name ?? '').startsWith(PREFIX))
  check('岗位无残留', titleLeft.length === 0, titleLeft.map((t) => t.name).join(',') || '已清空')

  const orgs = await api('GET', `/external-orgs?q=${encodeURIComponent(PREFIX)}`)
  const orgLeft = (orgs.json?.data?.items ?? []).filter((o) => (o.name ?? '').startsWith(PREFIX))
  check('外部主体无残留', orgLeft.length === 0, orgLeft.map((o) => o.name).join(',') || '已清空')

  const users = await api('GET', `/admin/users?q=${encodeURIComponent(PREFIX)}&limit=100`)
  const userLeft = (users.json?.data?.items ?? []).filter((u) => (u.name ?? '').startsWith(PREFIX))
  check('测试用户无残留', userLeft.length === 0, userLeft.map((u) => u.name).join(',') || '已清空')
}

// ── 执行 ────────────────────────────────────────────────────────────────────
const t0 = Date.now()
console.log(`QA B2a-1 组织链 e2e  |  BASE=${BASE}  |  ADMIN=${ADMIN.email}`)
try {
  await preClean()
  try {
    await main()
  } finally {
    await cleanup()
  }
  await verifyClean()
} catch (e) {
  check('脚本未捕获异常', false, String(e?.stack ?? e))
}

const total = pass + fail + skip
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n━━━ 汇总: ${total} 项 = PASS ${pass} / FAIL ${fail} / SKIP ${skip}  |  耗时 ${secs}s ━━━`)
process.exit(fail === 0 ? 0 : 1)
