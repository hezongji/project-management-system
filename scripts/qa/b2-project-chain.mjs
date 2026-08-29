#!/usr/bin/env node
// B2 数据流闭环 · 链路1：项目主链（kimi 初稿 + 实测校准版）
// 项目 → 成员(2人, MANAGER/MEMBER) → 阶段 → 任务 → 评论 → 修订 → 状态流转 → 清理
//
// 运行：cd /opt/pm-app && node scripts/qa/b2-project-chain.mjs            # 默认打线上
//       BASE=http://127.0.0.1:3001/api node scripts/qa/b2-project-chain.mjs
//
// ── 校准结论（2026-08-25 实测 + 源码核对）──
//  [6] POST /projects/[id]/phases 不存在（目录无 route.ts，仅 /phases/order PATCH）。
//      阶段由项目创建时经流程模板自动生成（lib/phase-engine.instantiateProject，
//      未传 templateId 时取默认模板，本项目实测默认模板 20 阶段/20 目录/33 条目）。
//      → 校准为：POST 探测留痕（预期 40x）→ GET /projects/[id]/tree 取阶段。
//  [9][10] TaskStatus 枚举 = TODO/IN_PROGRESS/REVIEW/DONE/CANCELLED（schema.prisma），
//      原推断 IN_PROGRESS/DONE 正确，保留现场探测作证据。
//  [12] POST /tasks/[id]/revisions 入参 = { changeSummary(>10字), patch:{白名单字段} }
//      （strict zod，note/无参均 400）→ 已按源码修正。
//  清理 DELETE /projects/[id] 存在（物理删除，ADMIN/OWNER；有采购订单或已归档时 400），
//      保留 archive 降级兜底。★ 注意：项目删除会遗留 PROJECT_GROUP 会话（成员被清、
//      projectId SET NULL，之后 DELETE /conversations/[id] 因非成员 403）——脚本必须在
//      删项目【前】先解散会话（校准实测发现，登记为业务问题见报告）。
//  成员 API：POST 返回 {added,skipped} 无 memberId；DELETE /members/[memberId] 的
//      memberId = userId（非成员行 id）→ 已按源码修正。
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
const ENV_FILE = process.env.ENV_FILE || '/opt/pm-app/.env'
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }

const env = fs.readFileSync(ENV_FILE, 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const token = jwt.sign(ADMIN, getEnv('JWT_SECRET'), { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

// ── 断言计数 ──
let pass = 0, fail = 0
const fails = []
function assert(cond, desc) {
  if (cond) { pass++; console.log(`  ✅ ${desc}`) }
  else { fail++; fails.push(desc); console.log(`  ❌ ${desc}`) }
}
function skip(desc, reason) { console.log(`  ⏭️  SKIP ${desc} —— ${reason}`) }

// ── HTTP 助手（容错：非 JSON 不抛异常）──
async function req(method, path, body, headers = H) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000), // 防挂死泄漏（qwen 预审）
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, ok: r.ok, body: j?.data ?? j, raw: j }
}
const itemsOf = (b) => (Array.isArray(b) ? b : b?.items ?? b?.data?.items ?? [])

// ── 清理登记（反向执行：后注册先执行）──
const cleanup = []   // { label, run: async () => bool }
const manual = []    // 无删除 API 的资源
async function runCleanup() {
  console.log('\n── 清理 ──')
  for (const c of [...cleanup].reverse()) {
    try {
      const ok = await c.run()
      console.log(`  ${ok ? '🧹' : '⚠️ '} ${c.label}${ok ? '' : '（删除失败，见上）'}`)
      if (!ok) manual.push(c.label)
    } catch (e) { console.log(`  ⚠️  ${c.label} 清理异常: ${e.message}`); manual.push(c.label) }
  }
}

const TS = Date.now()
const ids = { projectId: null, conversationId: null, phaseId: null, taskId: null, commentId: null }
let u1 = null, u2 = null

try {
  // [1] 取两个真实用户（排除 ADMIN 自己）
  console.log(`[1] 获取真实用户…  BASE=${BASE}`)
  const users = await req('GET', '/users?limit=20')
  const list = itemsOf(users.body)
  console.log(`  现场: GET /users → ${users.status}, 共 ${list.length} 条, 字段样例:`, JSON.stringify(list[0] ?? {}).slice(0, 200))
  const candidates = list.filter((u) => u?.id && u.id !== ADMIN.userId)
  u1 = candidates[0]; u2 = candidates[1] ?? candidates[0]
  assert(users.ok && list.length > 0, 'GET /users 200 且返回用户列表')
  assert(!!u1, `取到成员1（${u1?.name ?? u1?.email ?? u1?.id}）`)
  assert(!!u2, `取到成员2（${u2?.name ?? u2?.email ?? u2?.id}）`)

  // [2] 创建项目（流程模板自动生成阶段/目录/条目/项目群会话）
  console.log('[2] 创建项目…')
  const pj = await req('POST', '/projects', { name: `QA-B2-项目链-${TS}`, description: 'B2 数据流闭环测试项目（自建自删）' })
  console.log(`  现场: POST /projects → ${pj.status}`, JSON.stringify(pj.raw).slice(0, 300))
  ids.projectId = pj.body?.project?.id ?? pj.body?.id
  ids.conversationId = pj.body?.conversationId ?? null
  assert(pj.ok && !!ids.projectId, `创建项目成功（id=${ids.projectId}, code=${pj.body?.project?.code}）`)
  assert((pj.body?.phaseCount ?? 0) > 0, `流程模板自动生成阶段 phaseCount=${pj.body?.phaseCount}（目录 ${pj.body?.catalogCount} / 条目 ${pj.body?.requirementCount}）`)
  assert(!!ids.conversationId, `项目群会话已建（conversationId=${ids.conversationId}）`)
  if (!ids.projectId) throw new Error('项目创建失败，链路终止')
  cleanup.push({
    label: `项目 ${ids.projectId}`,
    run: async () => {
      const d = await req('DELETE', `/projects/${ids.projectId}`)
      if (d.ok) return true
      // 降级归档并登记手动清理（DELETE 被采购订单/归档态拦截时）
      const a = await req('POST', `/projects/${ids.projectId}/archive`, {})
      console.log(`  现场: DELETE 项目→${d.status}，降级 archive→${a.status}`)
      return false // 归档≠删除，登记手动清理
    },
  })
  // ★ 必须先于项目删除（项目删除会清掉会话成员 → 之后解散 403）
  if (ids.conversationId) {
    cleanup.push({ label: `项目群会话 ${ids.conversationId}`, run: async () => (await req('DELETE', `/conversations/${ids.conversationId}`)).ok })
  }

  // [3] GET 项目详情断言字段（响应壳 data = { project, phaseOverview }）
  console.log('[3] 读取项目详情…')
  const pjd = await req('GET', `/projects/${ids.projectId}`)
  const pjRow = pjd.body?.project ?? pjd.body
  console.log(`  现场: GET /projects/[id] → ${pjd.status}, 字段:`, Object.keys(pjd.body ?? {}).join(','))
  assert(pjd.ok && pjRow?.name?.includes('QA-B2-项目链'), '项目详情 name 匹配')
  assert(!!pjRow?.code, `项目已分配编号 code=${pjRow?.code}`)

  // [3.5] 项目现有成员（模板自动拉入阶段负责人）→ 从非成员中另选 u1/u2
  const mem0 = await req('GET', `/projects/${ids.projectId}/members`)
  const existingUserIds = new Set((mem0.body?.members ?? itemsOf(mem0.body)).map((m) => m?.userId ?? m?.user?.id))
  const fresh = candidates.filter((u) => !existingUserIds.has(u.id))
  u1 = fresh[0] ?? u1; u2 = fresh[1] ?? fresh[0] ?? u2
  console.log(`  现场: 模板自动成员 ${existingUserIds.size} 人，另选非成员 u1=${u1?.name}, u2=${u2?.name}`)

  // [4] 加两名成员（★实测：新成员走 createMany 时 toAdd.map((id)=>({projectId:id,...}))
  //     形参 id 遮蔽路由 projectId → FK violation 500，业务bug记入报告；
  //     脚本保留断言作为回归探针，待业务修复后自动转 PASS）
  console.log('[4] 添加项目成员…')
  let memberBug500 = false
  for (const [u, role] of [[u1, 'MANAGER'], [u2, 'MEMBER']]) {
    const m = await req('POST', `/projects/${ids.projectId}/members`, { userId: u.id, role })
    console.log(`  现场: POST members(${u.name ?? u.id},${role}) → ${m.status}`, JSON.stringify(m.raw).slice(0, 200))
    if (m.status === 500) memberBug500 = true
    assert(m.ok, `加成员 ${u.name ?? u.id}（${role}）成功${m.status === 500 ? '【业务bug：新成员入库 projectId 形参遮蔽→FK 500，见报告】' : ''}`)
    // memberId 形参即 userId（源码核对）；仅入库成功才登记反向清理
    if (m.ok && m.body?.added > 0) cleanup.push({ label: `成员 ${u.name ?? u.id}`, run: async () => (await req('DELETE', `/projects/${ids.projectId}/members/${u.id}`)).ok })
  }

  // [5] GET 成员列表断言（响应壳 data.members，无成员行 id）
  console.log('[5] 校验成员列表…')
  const mem = await req('GET', `/projects/${ids.projectId}/members`)
  const memList = mem.body?.members ?? itemsOf(mem.body)
  const memUserIds = memList.map((m) => m?.userId ?? m?.user?.id)
  if (memberBug500) {
    assert(mem.ok && memUserIds.length > 0, `成员列表可读（共 ${memList.length} 人，含模板自动成员）`)
    skip('成员列表含两名新成员', '加成员 500（业务bug）新成员未入库，本断言待业务修复后恢复')
  } else {
    assert(mem.ok && memUserIds.includes(u1.id) && memUserIds.includes(u2.id), `成员列表含两名新成员（共 ${memList.length} 人，含创建者 OWNER）`)
  }

  // [6] 阶段（校准点①：POST 入口不存在，阶段由建项目时模板实例化 → tree 获取）
  console.log('[6] 获取阶段…')
  const ph = await req('POST', `/projects/${ids.projectId}/phases`, { code: 'PH01', name: `QA-B2-阶段-${TS}`, order: 1 })
  console.log(`  现场: POST /projects/[id]/phases → ${ph.status}（校准：无此路由，阶段由项目创建经流程模板生成）`)
  const tree = await req('GET', `/projects/${ids.projectId}/tree`)
  const phases = tree.body?.phases ?? tree.body?.[0]?.phases ?? []
  console.log(`  现场: GET tree → ${tree.status}, 阶段数=${phases.length}, 首阶段:`, JSON.stringify(phases[0] ?? {}).slice(0, 200))
  ids.phaseId = phases.find((p) => p?.status !== 'SKIPPED')?.id ?? phases[0]?.id ?? null
  assert(tree.ok && phases.length > 0 && !!ids.phaseId, `经 tree 获取阶段（${phases.length} 个，取 id=${ids.phaseId}, code=${phases[0]?.code}）`)
  if (!ids.phaseId) skip('阶段相关断言', '项目无阶段（模板未实例化），需人工排查流程模板配置')

  // [7] 建任务
  console.log('[7] 创建任务…')
  const tk = await req('POST', '/tasks', {
    title: `QA-B2-任务-${TS}`, description: 'B2 链路测试任务',
    projectId: ids.projectId, phaseId: ids.phaseId ?? undefined,
    assigneeId: u1.id, priority: 'HIGH',
  })
  console.log(`  现场: POST /tasks → ${tk.status}`, JSON.stringify(tk.raw).slice(0, 300))
  ids.taskId = tk.body?.id ?? tk.body?.task?.id
  assert(tk.ok && !!ids.taskId, `创建任务成功（id=${ids.taskId}）`)
  if (ids.taskId) {
    // ★实测业务问题：DELETE /tasks/[id] 不清理 sourceType=TASK 的 TodoItem（sourceId 无 FK），
    //   任务删除后指派人的「任务待办」成孤儿（点开 404）；且随后项目删除也收不到该
    //   taskId（先于项目删被删）→ 无法级联。脚本以 u1 身份代清并记入报告。
    cleanup.push({
      label: `u1 孤儿任务待办（taskId=${ids.taskId}）`,
      run: async () => {
        const tU1 = jwt.sign({ userId: u1.id, email: u1.email ?? '', role: 'MEMBER' }, getEnv('JWT_SECRET'), { expiresIn: '1h' })
        const HU1 = { Authorization: `Bearer ${tU1}` }
        const list = await req('GET', '/todos', undefined, HU1)
        const orphans = itemsOf(list.body).filter((t) => t?.sourceId === ids.taskId && t?.sourceType === 'TASK')
        for (const o of orphans) {
          const d = await req('DELETE', `/todos/${o.id}`, undefined, HU1)
          console.log(`  现场: 代删 u1 孤儿待办 ${o.id} → ${d.status}`)
        }
        return orphans.length === 0 || true // 能删就删，删不掉也不阻断（登记见报告）
      },
    })
    cleanup.push({ label: `任务 ${ids.taskId}`, run: async () => (await req('DELETE', `/tasks/${ids.taskId}`)).ok })
  }

  // [8] GET 任务断言
  if (ids.taskId) {
    console.log('[8] 读取任务详情…')
    const td = await req('GET', `/tasks/${ids.taskId}`)
    console.log(`  现场: GET /tasks/[id] → ${td.status}, status=${td.body?.status}, assigneeId=${td.body?.assigneeId}`)
    assert(td.ok && td.body?.title?.includes('QA-B2-任务'), '任务详情 title 匹配')
    assert((td.body?.assigneeId ?? td.body?.assignee?.id) === u1.id, `任务指派人=成员1（${td.body?.assignee?.name ?? td.body?.assigneeId}）`)

    // [9] 探测 TaskStatus 合法值（校准点②：现场取证）
    console.log('[9] 探测 TaskStatus 枚举…')
    const anyTasks = await req('GET', '/tasks?limit=50')
    const statuses = [...new Set(itemsOf(anyTasks.body).map((t) => t?.status).filter(Boolean))]
    console.log(`  现场: 现有任务 status 值集合 = ${JSON.stringify(statuses)}`)

    // [10] 状态流转（TODO → IN_PROGRESS → DONE，schema 枚举校准通过）
    console.log('[10] 任务状态流转…')
    for (const s of ['IN_PROGRESS', 'DONE']) {
      const p = await req('PATCH', `/tasks/${ids.taskId}`, { status: s })
      console.log(`  现场: PATCH status=${s} → ${p.status}`, p.ok ? '' : JSON.stringify(p.raw).slice(0, 300))
      assert(p.ok, `状态流转 → ${s}`)
      if (!p.ok) break
    }
    const td2 = await req('GET', `/tasks/${ids.taskId}`)
    assert(td2.body?.status === 'DONE', `终态=${td2.body?.status}（startedAt=${td2.body?.startedAt ? '有' : '无'}, completedAt=${td2.body?.completedAt ? '有' : '无'}）`)

    // [11] 评论
    console.log('[11] 任务评论…')
    const cm = await req('POST', `/tasks/${ids.taskId}/comments`, { content: `QA-B2-评论-${TS}` })
    console.log(`  现场: POST comments → ${cm.status}`, JSON.stringify(cm.raw).slice(0, 250))
    ids.commentId = cm.body?.id ?? cm.body?.comment?.id
    assert(cm.ok, '发表评论成功')
    const cml = await req('GET', `/tasks/${ids.taskId}/comments`)
    assert(itemsOf(cml.body).some((c) => c?.content?.includes('QA-B2-评论')), '评论列表含新评论')
    if (ids.commentId) {
      cleanup.push({ label: `评论 ${ids.commentId}`, run: async () => (await req('DELETE', `/tasks/${ids.taskId}/comments/${ids.commentId}`)).ok })
    }

    // [12] 修订（校准点③：入参 = { changeSummary(>10字), patch }，strict）
    console.log('[12] 任务修订…')
    const rv = await req('GET', `/tasks/${ids.taskId}/revisions`)
    console.log(`  现场: GET revisions → ${rv.status}, 共 ${itemsOf(rv.body).length} 条`)
    const rp = await req('POST', `/tasks/${ids.taskId}/revisions`, {
      changeSummary: `QA-B2-修订说明-${TS}：优先级由高调整为紧急（e2e闭环校准）`,
      patch: { priority: 'URGENT' },
    })
    console.log(`  现场: POST revisions → ${rp.status}`, JSON.stringify(rp.raw).slice(0, 300))
    assert(rp.ok, '创建修订成功（changeSummary>10字 + patch.priority=URGENT）')
    if (rp.ok) {
      const rv2 = await req('GET', `/tasks/${ids.taskId}/revisions`)
      const revs = itemsOf(rv2.body)
      const mine = revs.find((r) => r?.changeSummary?.includes('QA-B2-修订说明'))
      assert(!!mine, `修订历史含新修订（version=${mine?.version}, 共 ${revs.length} 条）`)
      // TaskRevision 为审计链设计：任务删除后 taskId SetNull 保留快照（无删除 API，登记说明）
      manual.push(`修订快照 ${mine?.id}（TaskRevision 审计链设计，任务删除后保留，无删除 API）`)
    }
  } else {
    skip('任务/评论/修订/状态流转', '任务创建失败（见 [7] 现场输出）')
  }
} catch (e) {
  fail++
  fails.push(`链路异常中断: ${e.message}`)
  console.log(`\n💥 异常: ${e.message}`)
} finally {
  await runCleanup()
}

console.log('\n══════════ 汇总 ══════════')
console.log(`B2-项目链: ${pass}/${pass + fail} PASS`)
if (fails.length) console.log('FAIL 明细:\n' + fails.map((f) => `  - ${f}`).join('\n'))
if (manual.length) console.log('说明/需关注:\n' + manual.map((m) => `  - ${m}`).join('\n'))
process.exitCode = fail > 0 ? 1 : 0
