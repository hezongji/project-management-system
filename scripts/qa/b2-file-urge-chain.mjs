#!/usr/bin/env node
// B2 数据流闭环 · 链路2：交付+催办链（kimi 初稿 + 实测校准版）
// 项目(载体,模板自动建目录) → 文件需求(WAITING) → 催办(UrgeRecord ACTIVE+TodoItem)
//   → 责任人提交(multipart, WAITING→SUBMITTED, 催办 DONE) → 计划外上传 → 预览/下载 → 清理
//
// 运行：cd /opt/pm-app && node scripts/qa/b2-file-urge-chain.mjs            # 默认打线上
//       BASE=http://127.0.0.1:3001/api node scripts/qa/b2-file-urge-chain.mjs
//
// ── 校准结论（2026-08-25 实测 + 源码核对）──
//  [2] 新项目默认 catalog：存在——instantiateProject 按模板生成 catalogCount 个目录
//      （实测默认模板 20 个）；GET /projects/[id]/catalogs 响应壳 data.items 为树根数组。
//      保留 POST 目录兜底。
//  [5] 催办创建入口【存在】：POST /projects/[id]/deliverables { requirementIds: [...] }
//      （lib/phase-engine.urgeRequirements：UrgeRecord ACTIVE + TodoItem + notify:push）
//      → 原脚本「仅 GET 验证」改为全闭环：催办 → GET /urges/mine 双视角 → 提交 → DONE。
//  [6] POST /file-requirements/[id]/submit 不是空 JSON——multipart(file) 单文件提交，
//      事务内 version+1、status=SUBMITTED、催办 DONE（targetUserId=提交人）、通知审核人。
//      审核人 = reviewerId ?? 阶段负责人 ?? 项目 OWNER。提交权限：条目责任人(owner)有 upload。
//  [7] /files/upload FormData 字段 = file + catalogId（必填；projectId/requirementId 无效，
//      计划外文件 requirementId 恒 null），响应壳 data.file.id → 已按 zod schema 修正。
//      预览仅 image/*、application/pdf 内联（text/plain 415）→ 预览断言改用 1x1 PNG。
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn/api').replace(/\/+$/, '')
const ENV_FILE = process.env.ENV_FILE || '/opt/pm-app/.env'
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }

const env = fs.readFileSync(ENV_FILE, 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const token = jwt.sign(ADMIN, SECRET, { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

let pass = 0, fail = 0
const fails = []
function assert(cond, desc) {
  if (cond) { pass++; console.log(`  ✅ ${desc}`) }
  else { fail++; fails.push(desc); console.log(`  ❌ ${desc}`) }
}
function skip(desc, reason) { console.log(`  ⏭️  SKIP ${desc} —— ${reason}`) }

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

const cleanup = []
const manual = []
async function runCleanup() {
  console.log('\n── 清理 ──')
  for (const c of [...cleanup].reverse()) {
    try {
      const ok = await c.run()
      console.log(`  ${ok ? '🧹' : '⚠️ '} ${c.label}${ok ? '' : '（删除失败/无删除API，登记手动清理）'}`)
      if (!ok) manual.push(c.label)
    } catch (e) { console.log(`  ⚠️  ${c.label} 清理异常: ${e.message}`); manual.push(c.label) }
  }
}

const TS = Date.now()
const ids = { projectId: null, conversationId: null, catalogId: null, requirementId: null, fileId: null }
let u1 = null

try {
  // [1] 建载体项目（文件需求必挂 projectId + catalogId；模板自动生成目录/条目/项目群会话）
  console.log(`[1] 创建载体项目…  BASE=${BASE}`)
  const pj = await req('POST', '/projects', { name: `QA-B2-文件链-${TS}`, description: 'B2 交付+催办链测试载体（自建自删）' })
  console.log(`  现场: POST /projects → ${pj.status}`, JSON.stringify({ id: pj.body?.project?.id, code: pj.body?.project?.code, catalogs: pj.body?.catalogCount, reqs: pj.body?.requirementCount }))
  ids.projectId = pj.body?.project?.id ?? pj.body?.id
  ids.conversationId = pj.body?.conversationId ?? null
  assert(pj.ok && !!ids.projectId, `载体项目创建成功（id=${ids.projectId}, code=${pj.body?.project?.code}）`)
  if (!ids.projectId) throw new Error('项目创建失败，链路终止')
  cleanup.push({
    label: `项目 ${ids.projectId}`,
    run: async () => {
      const d = await req('DELETE', `/projects/${ids.projectId}`)
      if (!d.ok) await req('POST', `/projects/${ids.projectId}/archive`, {})
      return d.ok
    },
  })
  // 项目群会话须先于项目删除解散（项目删除清成员后解散会 403）
  if (ids.conversationId) {
    cleanup.push({ label: `项目群会话 ${ids.conversationId}`, run: async () => (await req('DELETE', `/conversations/${ids.conversationId}`)).ok })
  }

  // [1.5] 取责任人 u1（催办目标 + 提交人；条目 owner 才有 upload 权限），并拉入项目成员
  const users = await req('GET', '/users?limit=20')
  u1 = itemsOf(users.body).find((u) => u?.id && u.id !== ADMIN.userId)
  assert(!!u1, `取到责任人 u1=${u1?.name ?? u1?.id}`)
  if (u1) {
    const am = await req('POST', `/projects/${ids.projectId}/members`, { userId: u1.id, role: 'MEMBER' })
    console.log(`  现场: 加成员 ${u1?.name} → ${am.status}（500=已知业务bug：新成员入库 projectId 形参遮蔽；u1 凭条目 owner 亦有 upload 权限，链路继续）`, JSON.stringify(am.raw).slice(0, 150))
  }

  // [2] 探测文件目录 catalogId（校准点⑤：模板已自动建目录，data.items 为树根）
  console.log('[2] 探测文件目录 catalogs…')
  const cat = await req('GET', `/projects/${ids.projectId}/catalogs`)
  const catalogs = itemsOf(cat.body)
  console.log(`  现场: GET catalogs → ${cat.status}, 根目录 ${catalogs.length} 个, 样例:`, JSON.stringify(catalogs[0] ?? {}).slice(0, 200))
  if (catalogs.length === 0) {
    const c = await req('POST', `/projects/${ids.projectId}/catalogs`, { name: `QA-B2-目录-${TS}` })
    console.log(`  现场: POST catalogs → ${c.status}`, JSON.stringify(c.raw).slice(0, 250))
    ids.catalogId = c.body?.id ?? c.body?.catalog?.id ?? itemsOf(c.body)[0]?.id
  } else {
    ids.catalogId = catalogs[0]?.id
  }
  assert(!!ids.catalogId, `取到 catalogId=${ids.catalogId}`)

  // [3] 建文件需求（ownerId=u1：催办目标 + upload 权限归属）
  console.log('[3] 创建文件需求…')
  let fr = { ok: false }
  if (ids.catalogId && u1) {
    fr = await req('POST', '/file-requirements', {
      projectId: ids.projectId, catalogId: ids.catalogId, ownerId: u1.id,
      name: `QA-B2-电气图纸-${TS}.pdf`, required: true, purpose: 'B2链路测试',
    })
    console.log(`  现场: POST /file-requirements → ${fr.status}`, JSON.stringify(fr.raw).slice(0, 300))
    ids.requirementId = fr.body?.id ?? fr.body?.requirement?.id
    assert(fr.ok && !!ids.requirementId, `文件需求创建成功（id=${ids.requirementId}）`)
    if (ids.requirementId) {
      cleanup.push({
        label: `文件需求 ${ids.requirementId}`,
        run: async () => {
          const d = await req('DELETE', `/file-requirements/${ids.requirementId}`)
          if (d.ok) return true
          // 非 WAITING（已提交）禁止物理删除为审计链设计（随项目删除级联清理）
          const designed = d.status === 400 && JSON.stringify(d.raw ?? '').includes('已提交')
          console.log(`  现场: DELETE 需求 → ${d.status}（${designed ? '已提交条目禁删为审计设计，随项目级联' : JSON.stringify(d.raw).slice(0, 150)}）`)
          return designed
        },
      })
    }
  } else {
    skip('文件需求创建', '无 catalogId 或无责任人')
  }

  // [4] GET 断言初始状态 WAITING
  let st0 = null
  if (ids.requirementId) {
    console.log('[4] 读取文件需求…')
    const fd = await req('GET', `/file-requirements/${ids.requirementId}`)
    st0 = fd.body?.status
    console.log(`  现场: status=${st0}, 字段:`, Object.keys(fd.body ?? {}).join(','))
    assert(fd.ok && fd.body?.name?.includes('QA-B2-'), '文件需求 name 匹配')
    assert(st0 === 'WAITING', `初始 status=${st0}（预期 WAITING）`)
  } else {
    skip('文件需求读取', '需求创建失败')
  }

  // [5] 催办（校准：POST /projects/[id]/deliverables 存在 → 全闭环）
  console.log('[5] 催办闭环…')
  if (ids.requirementId) {
    const ug = await req('POST', `/projects/${ids.projectId}/deliverables`, { requirementIds: [ids.requirementId] })
    console.log(`  现场: POST /deliverables → ${ug.status}`, JSON.stringify(ug.raw).slice(0, 250))
    assert(ug.ok, `催办发起成功（notified=${ug.body?.notified} → ${ug.body?.notifiedUserIds?.length ?? 0} 人）`)

    const tokenU1 = jwt.sign({ userId: u1.id, email: u1.email ?? '', role: 'MEMBER' }, SECRET, { expiresIn: '1h' })
    const HU1 = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenU1}` }
    const mineA = await req('GET', '/urges/mine')
    const mineU = await req('GET', '/urges/mine', undefined, HU1)
    const outHit = (mineA.body?.outgoing ?? []).some((r) => r?.requirementId === ids.requirementId && r?.status === 'ACTIVE')
    const inHit = (mineU.body?.incoming ?? []).some((r) => r?.requirementId === ids.requirementId && r?.status === 'ACTIVE')
    console.log(`  现场: /urges/mine ADMIN outgoing=${mineA.body?.outgoingCount}, u1 incoming=${mineU.body?.incomingCount}`)
    assert(mineA.ok && mineU.ok && ['incoming', 'outgoing', 'recentlyDone'].every((k) => k in (mineA.body ?? {})), 'GET /urges/mine 双视角 200 且结构完整（incoming/outgoing/recentlyDone）')
    assert(outHit, '催办人（ADMIN）outgoing 含 ACTIVE 催办记录')
    assert(inHit, `被催人（${u1?.name}）incoming 含 ACTIVE 催办记录`)
    ids._HU1 = HU1
  } else {
    skip('催办闭环', '需求创建失败')
  }

  // [6] 责任人提交（multipart file；WAITING→SUBMITTED；催办 ACTIVE→DONE）
  console.log('[6] 责任人提交文件…')
  if (ids.requirementId && ids._HU1) {
    const fdS = new FormData()
    fdS.append('file', new Blob([`QA-B2 交付内容 ${TS}`], { type: 'text/plain' }), `qa-b2-deliver-${TS}.txt`)
    const sb = await fetch(`${BASE}/file-requirements/${ids.requirementId}/submit`, {
      method: 'POST', headers: { Authorization: ids._HU1.Authorization }, body: fdS,
      signal: AbortSignal.timeout(30000),
    })
    const sbj = await sb.json().catch(() => null)
    console.log(`  现场: POST submit(multipart) → ${sb.status}`, JSON.stringify(sbj).slice(0, 300))
    assert(sb.ok, `提交成功（fileId=${sbj?.data?.file?.id ?? sbj?.data?.id}）`)
    const fd2 = await req('GET', `/file-requirements/${ids.requirementId}`)
    assert(fd2.body?.status === 'SUBMITTED', `状态流转 ${st0} → ${fd2.body?.status}`)
    // 催办闭环：被催人已处理 → DONE + recentlyDone
    const mineU2 = await req('GET', '/urges/mine', undefined, ids._HU1)
    const doneHit = (mineU2.body?.recentlyDone ?? []).some((r) => r?.requirementId === ids.requirementId)
      || (mineU2.body?.incoming ?? []).every((r) => r?.requirementId !== ids.requirementId)
    const recDone = (mineU2.body?.recentlyDone ?? []).find((r) => r?.requirementId === ids.requirementId)
    console.log(`  现场: u1 /urges/mine recentlyDone=${(mineU2.body?.recentlyDone ?? []).length}, 本条=${recDone?.status ?? '不在incoming(已DONE)'}`)
    assert(doneHit, '催办闭环（提交后 u1 视角催办不再 ACTIVE，进入 DONE/recentlyDone）')
  } else {
    skip('提交/催办闭环验证', '需求创建失败')
  }

  // [7] 计划外文件上传（校准点⑥：multipart file + catalogId → data.file.id）
  console.log('[7] 上传计划外文件（multipart file+catalogId）…')
  if (ids.catalogId) {
    // 1x1 PNG（预览仅 image/* 与 pdf 支持，txt 会 415）
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const fd3 = new FormData()
    fd3.append('file', new Blob([png], { type: 'image/png' }), `qa-b2-upload-${TS}.png`)
    fd3.append('catalogId', ids.catalogId)
    const up = await fetch(`${BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // multipart 不可手设 Content-Type
      body: fd3,
      signal: AbortSignal.timeout(30000),
    })
    const upj = await up.json().catch(() => null)
    console.log(`  现场: POST /files/upload → ${up.status}`, JSON.stringify(upj).slice(0, 350))
    ids.fileId = upj?.data?.file?.id ?? upj?.data?.id
    assert(up.ok && !!ids.fileId, `上传成功（fileId=${ids.fileId}, size=${upj?.data?.file?.size}）`)
    if (up.ok && !ids.fileId) {
      // 上传成功但响应壳提取不到 fileId → 无从登记反向清理，手动登记防孤儿（qwen 预审）
      manual.push(`计划外上传文件（上传 2xx 但 fileId 提取失败，响应壳异常，需手动定位删除）`)
    }
    if (ids.fileId) {
      cleanup.push({ label: `文件 ${ids.fileId}`, run: async () => (await req('DELETE', `/files/${ids.fileId}`)).ok })

      // [8] 预览(inline 200) + 下载(200 且字节一致)
      console.log('[8] 预览/下载…')
      const pv = await fetch(`${BASE}/files/${ids.fileId}/preview`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
      assert(pv.status === 200, `预览 200 inline（实际 ${pv.status}, Content-Type=${pv.headers.get('content-type')}）`)
      const dl = await fetch(`${BASE}/files/${ids.fileId}/download`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
      const buf = dl.ok ? Buffer.from(await dl.arrayBuffer()) : Buffer.alloc(0)
      assert(dl.status === 200 && buf.length === png.length, `下载 200 且 ${buf.length} 字节与上传一致（实际 ${dl.status}）`)
    }
  } else {
    skip('上传/预览/下载', '无 catalogId（见 [2] 现场输出）')
  }
} catch (e) {
  fail++
  fails.push(`链路异常中断: ${e.message}`)
  console.log(`\n💥 异常: ${e.message}`)
} finally {
  await runCleanup()
}

console.log('\n══════════ 汇总 ══════════')
console.log(`B2-交付催办链: ${pass}/${pass + fail} PASS`)
if (fails.length) console.log('FAIL 明细:\n' + fails.map((f) => `  - ${f}`).join('\n'))
if (manual.length) console.log('需手动清理:\n' + manual.map((m) => `  - ${m}`).join('\n'))
process.exitCode = fail > 0 ? 1 : 0
