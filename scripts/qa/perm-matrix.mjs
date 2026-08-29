#!/usr/bin/env node
/**
 * QA B1-L2 —— GET 型 API 权限矩阵回归测试（可重复执行的回归资产）
 *
 * 用法:
 *   node scripts/qa/perm-matrix.mjs                        # 默认打线上 https://pm.hezongji.cn
 *   BASE=http://127.0.0.1:3001 node scripts/qa/perm-matrix.mjs
 *
 * 四种身份: A=无token, B=MEMBER, C=PROJECT_MANAGER, D=ADMIN
 *   B/C 从数据库取真实用户(psql, 排除 test/停用账号), D 固定 chenmuzhi(ADMIN, 与页面冒烟一致)。
 * 覆盖: src/app/api 下全部 54 个含 GET 的 route(逐一核对源码鉴权逻辑, 仅测 GET, 不写数据)。
 * 预期矩阵: 静态读每个 route.ts 的鉴权(requireAdmin/requireAuth/requireCan/可见性过滤)生成;
 *   项目级资源按 B/C 实际成员关系推导(非成员→403, 成员→200), 如实记录。
 * 判定: PASS(符合预期) / LEAK(预期401|403实际200, 越权) / DENY(预期200实际401|403, 误拒)
 *      / ERROR(其余不符, 含预期外 5xx/404)。
 * 退出码: 无 LEAK/DENY/ERROR → 0, 否则 1。
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { execFileSync } from 'child_process'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn').replace(/\/+$/, '')
const ENV_PATH = '/opt/pm-app/.env'
const ADMIN_ID = 'cmt7cdbzv001ov55otclrv94t' // chenmuzhi@example.com

// ── .env → JWT + DB 连接 ─────────────────────────────────────────────────────
const envText = fs.readFileSync(ENV_PATH, 'utf8')
const envGet = (k) =>
  envText.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)?.trim()
const JWT_SECRET = envGet('JWT_SECRET')
if (!JWT_SECRET) {
  console.error('FATAL: .env 缺少 JWT_SECRET')
  process.exit(2)
}
const dbUrl = envGet('DATABASE_URL') || ''
const m = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+)/)
if (!m) {
  console.error('FATAL: 无法解析 DATABASE_URL')
  process.exit(2)
}
const [, DB_USER, DB_PASS, DB_HOST, DB_PORT, DB_NAME] = m

/** psql 查询 → 行数组(制表符分列) */
function q(sql) {
  let out
  try {
    out = execFileSync(
      'psql',
      ['-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', DB_NAME, '-At', '-F', '\t', '-c', sql],
      { env: { ...process.env, PGPASSWORD: DB_PASS }, timeout: 15000 },
    ).toString()
  } catch (e) {
    console.error('FATAL: psql 查询失败:', e.message)
    process.exit(2)
  }
  return out
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('('))
    .map((l) => l.split('\t'))
}

console.log(`# QA B1-L2 API权限矩阵  target=${BASE}  db=${DB_NAME}@${DB_HOST}  time=${new Date().toISOString()}`)

// ── 身份取证 ────────────────────────────────────────────────────────────────
const pickUser = (role) =>
  q(
    `SELECT u.id, u.email, u.role, COALESCE(u."departmentId",''), COALESCE(d.name,''), u."purchaseFinanceGranted"
     FROM "User" u LEFT JOIN "Department" d ON d.id=u."departmentId"
     WHERE u.role='${role}' AND u."isActive"=true
       AND u.email NOT ILIKE '%test%' AND u.email NOT ILIKE '%deleted%'
     ORDER BY u.email LIMIT 1`,
  )[0]
const rowB = pickUser('MEMBER')
const rowC = pickUser('PROJECT_MANAGER')
const rowD = q(
  `SELECT u.id, u.email, u.role, COALESCE(u."departmentId",''), COALESCE(d.name,''), u."purchaseFinanceGranted"
   FROM "User" u LEFT JOIN "Department" d ON d.id=u."departmentId"
   WHERE u.id='${ADMIN_ID}' AND u.role='ADMIN' AND u."isActive"=true LIMIT 1`,
)[0]
if (!rowB || !rowC || !rowD) {
  console.error('FATAL: 数据库缺少可用的 MEMBER/PROJECT_MANAGER/ADMIN 真实账号')
  process.exit(2)
}
const mkUser = (r) => {
  const [id, email, role, deptId, dept, finGranted] = r
  return {
    id,
    email,
    role,
    deptId: deptId || null,
    dept,
    finGranted: finGranted === 't',
    isFinance: dept.includes('财务'),
    isPurchase: dept.includes('采购'),
  }
}
const B = mkUser(rowB)
const C = mkUser(rowC)
const D = mkUser(rowD)
const grants = q(
  `SELECT "userId", "scopeType" FROM "PurchaseScopeGrant" WHERE "userId" IN ('${B.id}','${C.id}')`,
)
B.hasAllGrant = grants.some((g) => g[0] === B.id && g[1] === 'PURCHASE_ALL')
C.hasAllGrant = grants.some((g) => g[0] === C.id && g[1] === 'PURCHASE_ALL')
console.log(
  `# B=${B.email}(${B.role}/${B.dept || '无部门'}) C=${C.email}(${C.role}/${C.dept || '无部门'}) D=${D.email}(${D.role})`,
)

const sign = (u) => jwt.sign({ userId: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '1h' })
const TOKENS = { B: sign(B), C: sign(C), D: sign(D) }

// ── 资源 id 取证(全部真实 id;成员关系如实推导预期) ──────────────────────────
// 项目 P: 优先取 C 的成员项目(让 C 走 200 路径), B 的成员关系另查
const projRow = q(
  `SELECT p.id, p.name FROM "Project" p
   JOIN "ProjectMember" pm ON pm."projectId"=p.id AND pm."userId"='${C.id}'
   ORDER BY pm."joinedAt" ASC LIMIT 1`,
)[0] ||
  q(`SELECT id, name FROM "Project" ORDER BY "createdAt" DESC LIMIT 1`)[0]
const P = { id: projRow[0], name: projRow[1] }

const memberRole = (uid, pid) =>
  q(
    `SELECT role FROM "ProjectMember" WHERE "userId"='${uid}' AND "projectId"='${pid}' LIMIT 1`,
  )[0]?.[0] ?? null
P.Brole = memberRole(B.id, P.id)
P.Crole = memberRole(C.id, P.id)

// 阶段/任务: 取 P 的第一个阶段与第一个任务
const phaseRow = q(
  `SELECT id FROM "Phase" WHERE "projectId"='${P.id}' ORDER BY "order" ASC LIMIT 1`,
)[0]
const taskRow = q(
  `SELECT t.id, t."phaseId", t."assigneeId", COALESCE(ph."ownerId",''), t."projectId"
   FROM "Task" t LEFT JOIN "Phase" ph ON ph.id=t."phaseId"
   WHERE t."projectId"='${P.id}' ORDER BY t.id ASC LIMIT 1`,
)[0]
const task = taskRow
  ? {
      id: taskRow[0],
      phaseId: taskRow[1],
      assigneeId: taskRow[2],
      phaseOwnerId: taskRow[3] || null,
      projectId: taskRow[4],
    }
  : null

// 文件: 取最新 pdf 且该文件条目无 ACL 授权行(保证预期可静态推导)
const fileRows = q(
  `SELECT f.id, fr.id, fr.scope, fr."scopeRefs", fr."ownerId", fr."phaseCode", f."projectId",
     (SELECT count(*) FROM "ResourcePermission" rp
       WHERE rp."resourceType"='FILE_REQ' AND rp."resourceId"=fr.id)
   FROM "File" f JOIN "FileRequirement" fr ON fr.id=f."requirementId"
   WHERE f."mimeType"='application/pdf'
   ORDER BY f."createdAt" DESC LIMIT 5`,
)
let file = null
for (const r of fileRows) {
  if (r[7] === '0') {
    file = {
      id: r[0],
      req: { id: r[1], scope: r[2], refs: JSON.parse(r[3] || '{}'), ownerId: r[4], phaseCode: r[5] },
      projectId: r[6],
    }
    break
  }
}
if (file) {
  file.memberRoleOf = { B: memberRole(B.id, file.projectId), C: memberRole(C.id, file.projectId) }
  file.phaseOwner = file.req.phaseCode
    ? q(
        `SELECT "ownerId" FROM "Phase" WHERE "projectId"='${file.projectId}' AND code='${file.req.phaseCode}' LIMIT 1`,
      )[0]?.[0] ?? null
    : null
}

// 会话: 最新一条 + B/C/D 是否成员
const convRow = q(
  `SELECT c.id,
     (SELECT count(*) FROM "ConversationMember" x WHERE x."conversationId"=c.id AND x."userId"='${B.id}'),
     (SELECT count(*) FROM "ConversationMember" x WHERE x."conversationId"=c.id AND x."userId"='${C.id}'),
     (SELECT count(*) FROM "ConversationMember" x WHERE x."conversationId"=c.id AND x."userId"='${D.id}')
   FROM "Conversation" c ORDER BY c."lastMessageAt" DESC NULLS LAST LIMIT 1`,
)[0]
const conv = convRow ? { id: convRow[0], B: convRow[1] === '1', C: convRow[2] === '1', D: convRow[3] === '1' } : null

// 单据: 最新报销单/采购清单/采购订单/品牌任务 + B/C 归属标记
const claimRow = q(
  `SELECT id,
     ("payeeId"='${B.id}' OR "createdById"='${B.id}'), ("payeeId"='${C.id}' OR "createdById"='${C.id}')
   FROM "ExpenseClaim" ORDER BY "createdAt" DESC LIMIT 1`,
)[0]
const prRow = q(
  `SELECT id, ("requesterId"='${B.id}' OR "handlerId"='${B.id}'), ("requesterId"='${C.id}' OR "handlerId"='${C.id}')
   FROM "PurchaseRequest" ORDER BY "createdAt" DESC LIMIT 1`,
)[0]
const poRow = q(
  `SELECT po.id,
     (po."creatorId"='${B.id}' OR po."ownerId"='${B.id}' OR po."receiverId"='${B.id}'
       OR EXISTS(SELECT 1 FROM "SupplierRequest" s JOIN "PurchaseRequest" r ON r.id=s."requestId"
                  WHERE s."orderId"=po.id AND r."requesterId"='${B.id}')),
     (po."creatorId"='${C.id}' OR po."ownerId"='${C.id}' OR po."receiverId"='${C.id}'
       OR EXISTS(SELECT 1 FROM "SupplierRequest" s JOIN "PurchaseRequest" r ON r.id=s."requestId"
                  WHERE s."orderId"=po.id AND r."requesterId"='${C.id}'))
   FROM "PurchaseOrder" po ORDER BY po."createdAt" DESC LIMIT 1`,
)[0]
const srRow2 = q(
  `SELECT s.id,
     (s."creatorId"='${B.id}' OR r."requesterId"='${B.id}'),
     (s."creatorId"='${C.id}' OR r."requesterId"='${C.id}')
   FROM "SupplierRequest" s LEFT JOIN "PurchaseRequest" r ON r.id=s."requestId"
   ORDER BY s."createdAt" DESC LIMIT 1`,
)[0]
const orderId = poRow?.[0] || ''

console.log(
  `# 项目P=${P.id}(${P.name}) B成员=${P.Brole ?? '否'} C成员=${P.Crole ?? '否'}`,
)
console.log(
  `# 资源: phase=${phaseRow?.[0] ?? '无'} task=${task?.id ?? '无'} file=${file?.id ?? '无'} conv=${conv?.id ?? '无'} claim=${claimRow?.[0] ?? '无'} pr=${prRow?.[0] ?? '无'} po=${orderId || '无'} sr=${srRow2?.[0] ?? '无'}`,
)

// ── 预期推导 ────────────────────────────────────────────────────────────────
const canFin = (u) => u.role === 'ADMIN' || u.isFinance || u.isPurchase || u.finGranted
const projView = (u) => u.role === 'ADMIN' || (u === B ? P.Brole !== null : u === C ? P.Crole !== null : true)
const taskView = (u) =>
  u.role === 'ADMIN' ||
  task === null ||
  memberRole(u.id, task.projectId) !== null ||
  task.assigneeId === u.id ||
  task.phaseOwnerId === u.id
/** 文件条目 view/download(范围终审, 与 lib/permission.ts 同口径; 所选条目无 ACL) */
const filePerm = (u) => {
  if (!file) return true
  if (u.role === 'ADMIN') return true
  const r = file.req
  const memberRoleF = u === B ? file.memberRoleOf.B : u === C ? file.memberRoleOf.C : null
  if (r.ownerId === u.id) return true // 条目责任人
  if (file.phaseOwner === u.id) return true // 定向审阅人
  if (r.scope === 'PUBLIC') return memberRoleF !== null
  if (r.scope === 'RESTRICTED')
    return (
      (r.refs.userIds || []).includes(u.id) ||
      (u.deptId !== null && (r.refs.deptIds || []).includes(u.deptId)) ||
      false
    )
  if (r.scope === 'PRIVATE') return memberRoleF === 'OWNER'
  return false
}

const R200 = () => 200
const adminOnly = { A: 401, B: 403, C: 403, D: 200 }
const authed200 = { A: 401, B: 200, C: 200, D: 200 }

/** 端点清单: [路径, 预期函数/对象, 备注] 预期来源=逐一阅读 route.ts 静态鉴权 */
const endpoints = [
  // ── 管理端(requireAdmin: 401/403/403/200) ──
  ['/api/admin/audit-logs', adminOnly, 'requireAdmin'],
  ['/api/admin/cleanup-stats', adminOnly, 'requireAdmin'],
  ['/api/admin/external-org-scopes', adminOnly, 'requireAdmin'],
  [`/api/admin/permissions/${B.id}`, adminOnly, 'requireAdmin'],
  ['/api/admin/settings', adminOnly, 'requireAdmin'],
  ['/api/admin/storage', adminOnly, 'requireAdmin'],
  ['/api/admin/users', adminOnly, 'requireAdmin'],
  // ── 登录即用(requireAuth, 数据按可见性过滤/脱敏) ──
  ['/api/analytics/overview', authed200, 'requireAuth+按项目过滤'],
  ['/api/auth/me', authed200, 'requireAuth'],
  ['/api/conversations', authed200, 'requireAuth+本人会话'],
  ['/api/dashboard/stats', authed200, 'requireAuth+成员项目统计'],
  ['/api/departments', authed200, 'requireAuth'],
  ['/api/expense-categories', authed200, 'requireAuth'],
  ['/api/external-orgs', authed200, 'requireAuth+类型可见性过滤'],
  [`/api/external-orgs/${q(`SELECT id FROM "ExternalOrg" LIMIT 1`)[0]?.[0] ?? 'NONE'}/contacts`, authed200, 'requireAuth(代码未做类型可见性过滤, 见报告备注)'],
  ['/api/file-requirements/mine', authed200, 'requireAuth+本人条目'],
  [`/api/file-requirements?projectId=${P.id}`, authed200, 'requireAuth+范围过滤'],
  ['/api/job-titles', authed200, 'requireAuth'],
  ['/api/notifications', authed200, 'requireAuth+本人通知'],
  ['/api/org-chart', authed200, 'requireAuth'],
  ['/api/process-templates', authed200, 'requireAuth'],
  ['/api/projects', authed200, 'requireAuth+成员项目过滤'],
  ['/api/purchase-contracts?orderId=' + orderId, authed200, 'requireAuth+金额脱敏'],
  ['/api/purchase-orders', authed200, 'requireAuth+单据范围过滤'],
  ['/api/purchase-requests', authed200, 'requireAuth+单据范围过滤'],
  ['/api/reports', authed200, 'requireAuth+成员项目过滤'],
  ['/api/search?q=%E7%A4%BA%E4%BE%8B', authed200, 'requireAuth+可见性过滤'],
  ['/api/supplier-requests', authed200, 'requireAuth+单据范围过滤'],
  ['/api/tasks', authed200, 'requireAuth+成员项目过滤'],
  ['/api/todos', authed200, 'requireAuth+本人待办'],
  ['/api/urges/mine', authed200, 'requireAuth+本人催办'],
  ['/api/users', authed200, 'requireAuth'],
  // ── 项目资源 requireCan('view', PROJECT): 成员/ADMIN 可见 ──
  [`/api/projects/${P.id}`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, `requireCan view PROJECT (B${P.Brole ? '是' : '非'}成员/C${P.Crole ? '是' : '非'}成员)`],
  [`/api/projects/${P.id}/tree`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/members`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/permissions`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/catalogs`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/deliverables`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/file-matrix`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '同上'],
  [`/api/projects/${P.id}/purchase-summary`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, '非ADMIN走成员项目过滤'],
  [`/api/projects/${P.id}/expense-claims`, authed200, 'requireAuth+报销可见范围过滤(不403)'],
  [`/api/projects/${P.id}/expense-claims/summary`, authed200, '同上'],
  // ── 阶段/任务 requireCan ──
  ...(phaseRow
    ? [[`/api/phases/${phaseRow[0]}`, { A: 401, B: P.Brole ? 200 : 403, C: P.Crole ? 200 : 403, D: 200 }, 'requireCan view PHASE(成员基线)']]
    : []),
  ...(task
    ? [
        [`/api/tasks/${task.id}`, { A: 401, B: taskView(B) ? 200 : 403, C: taskView(C) ? 200 : 403, D: 200 }, 'requireCan view TASK(成员/负责人/指派)'],
        [`/api/tasks/${task.id}/comments`, { A: 401, B: taskView(B) ? 200 : 403, C: taskView(C) ? 200 : 403, D: 200 }, '同上'],
        [`/api/tasks/${task.id}/revisions`, { A: 401, B: taskView(B) ? 200 : 403, C: taskView(C) ? 200 : 403, D: 200 }, '同上'],
      ]
    : []),
  // ── 会话成员制(ADMIN 也须是会话成员) ──
  ...(conv
    ? [[`/api/conversations/${conv.id}/messages`, { A: 401, B: conv.B ? 200 : 403, C: conv.C ? 200 : 403, D: conv.D ? 200 : 403 }, '须为会话成员(ADMIN不豁免)']]
    : []),
  // ── 财务门槛 ──
  ['/api/purchase-payments?orderId=' + orderId, { A: 401, B: canFin(B) ? 200 : 403, C: canFin(C) ? 200 : 403, D: 200 }, '仅采购/财务/ADMIN/授权(403硬拒)'],
  // ── 单据可见性(不可见=404) ──
  ...(claimRow
    ? [[`/api/expense-claims/${claimRow[0]}`, { A: 401, B: (B.isFinance || claimRow[1] === 't') ? 200 : 403, C: (C.isFinance || claimRow[2] === 't') ? 200 : 403, D: 200 }, '报销单: 财务/当事人可见, 其余403']]
    : []),
  ...(prRow
    ? [[`/api/purchase-requests/${prRow[0]}`, { A: 401, B: (B.isPurchase || B.hasAllGrant || prRow[1] === 't') ? 200 : 404, C: (C.isPurchase || C.hasAllGrant || prRow[2] === 't') ? 200 : 404, D: 200 }, '采购清单: 范围外404(不可见=不可达)']]
    : []),
  ...(poRow
    ? [[`/api/purchase-orders/${poRow[0]}`, { A: 401, B: (B.isPurchase || B.hasAllGrant || poRow[1] === 't') ? 200 : 404, C: (C.isPurchase || C.hasAllGrant || poRow[2] === 't') ? 200 : 404, D: 200 }, '采购订单: 范围外404']]
    : []),
  ...(srRow2
    ? [[`/api/supplier-requests/${srRow2[0]}`, { A: 401, B: (B.isPurchase || B.hasAllGrant || srRow2[1] === 't') ? 200 : 404, C: (C.isPurchase || C.hasAllGrant || srRow2[2] === 't') ? 200 : 404, D: 200 }, '品牌任务: 范围外404']]
    : []),
  // ── 文件(条目范围终审) ──
  ...(file
    ? [
        [`/api/files/${file.id}/download`, { A: 401, B: filePerm(B) ? 200 : 403, C: filePerm(C) ? 200 : 403, D: 200 }, `文件下载: scope=${file.req.scope} 范围终审`],
        [`/api/files/${file.id}/preview`, { A: 401, B: filePerm(B) ? 200 : 403, C: filePerm(C) ? 200 : 403, D: 200 }, '同上(pdf可预览)'],
      ]
    : []),
  // ── 文件条目详情 requireCan view FILE_REQ ──
  ...(file
    ? [[`/api/file-requirements/${file.req.id}`, { A: 401, B: filePerm(B) ? 200 : 403, C: filePerm(C) ? 200 : 403, D: 200 }, '条目详情: 范围终审同文件']]
    : []),
]

// ── 实测 ────────────────────────────────────────────────────────────────────
async function hit(path, tok) {
  const res = await fetch(`${BASE}${path}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.text().catch(() => '')
  return { status: res.status, body: body.slice(0, 160).replace(/\s+/g, ' ') }
}

const rows = []
for (const [path, exp, note] of endpoints) {
  const [a, b, c, d] = await Promise.all([
    hit(path, null),
    hit(path, TOKENS.B),
    hit(path, TOKENS.C),
    hit(path, TOKENS.D),
  ])
  const actual = { A: a.status, B: b.status, C: c.status, D: d.status }
  const bodies = { A: a.body, B: b.body, C: c.body, D: d.body }
  // 判定: 优先 LEAK(越权最严重), 次之 DENY(误拒), 其余不符为 ERROR
  let verdict = 'PASS'
  const detail = []
  for (const k of ['A', 'B', 'C', 'D']) {
    if (actual[k] === exp[k]) continue
    if (actual[k] === 200 && (exp[k] === 401 || exp[k] === 403)) verdict = 'LEAK'
    else if ((actual[k] === 401 || actual[k] === 403) && exp[k] === 200) verdict = verdict === 'LEAK' ? 'LEAK' : 'DENY'
    else verdict = verdict === 'LEAK' || verdict === 'DENY' ? verdict : 'ERROR'
    detail.push(`${k}: 预期${exp[k]}实际${actual[k]}`)
  }
  rows.push({ path, actual, exp, verdict, note, detail, bodies })
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const pad = (s, w) => String(s).padEnd(w)
console.log('')
console.log(`${pad('API', 62)}|A   |B   |C   |D   |预期(A/B/C/D)      |判定  |备注`)
console.log('-'.repeat(190))
for (const r of rows) {
  console.log(
    `${pad(r.path, 62)}|${pad(r.actual.A, 4)}|${pad(r.actual.B, 4)}|${pad(r.actual.C, 4)}|${pad(r.actual.D, 4)}|${pad(`${r.exp.A}/${r.exp.B}/${r.exp.C}/${r.exp.D}`, 19)}|${pad(r.verdict, 6)}|${r.note}`,
  )
}

const byVerdict = (v) => rows.filter((r) => r.verdict === v)
console.log('')
console.log('━━━ 异常明细 ━━━')
for (const v of ['LEAK', 'DENY', 'ERROR']) {
  const list = byVerdict(v)
  console.log(`[${v}] ${list.length} 个`)
  for (const r of list) {
    console.log(`  - ${r.path}`)
    console.log(`    ${r.detail.join('; ')}  (${r.note})`)
    for (const k of ['A', 'B', 'C', 'D']) {
      if (r.actual[k] !== r.exp[k]) console.log(`    ${k} body: ${r.bodies[k]}`)
    }
  }
}
console.log('')
const n = rows.length
console.log(
  `汇总: ${n} 个GET端点 × 4身份 = ${n * 4} 次请求 | PASS ${byVerdict('PASS').length}/${n}, LEAK ${byVerdict('LEAK').length}, DENY ${byVerdict('DENY').length}, ERROR ${byVerdict('ERROR').length}`,
)
process.exit(byVerdict('LEAK').length + byVerdict('DENY').length + byVerdict('ERROR').length > 0 ? 1 : 0)
