#!/usr/bin/env node
/**
 * QA B1-L1 —— 全站页面冒烟测试（可重复执行的回归资产）
 *
 * 用法:
 *   node scripts/qa/smoke-pages.mjs                        # 默认打线上 https://pm.hezongji.cn
 *   BASE=http://127.0.0.1:3001 node scripts/qa/smoke-pages.mjs
 *
 * 认证: 参照 scripts/e2e-full.mjs —— 读 /opt/pm-app/.env 的 JWT_SECRET,
 *       以 ADMIN 身份签 Bearer token（页面鉴权是客户端行为，SSR 只需 200 + 壳完整）。
 * 动态路由: 先 GET /api/projects 取真实项目 id（优先取有任务的项目），
 *          再 GET /api/projects/{id}/tree 取 phaseId；taskId 取自 /api/tasks?projectId=。
 * 断言: HTTP 200 + HTML 可见部分（剥离 RSC flight 内联脚本后）不含
 *      "Application error"/"This page could not be found"（App Router 每页都会把
 *      not-found 组件树内联进 self.__next_f 数据，不剥离必然误报）
 *      + 含 root 挂载点（<div id="__next"> 或 App Router 的 <body> 壳）。
 * 退出码: 全部 PASS → 0；否则 1（可直接接入 CI / 上线检查单）。
 */
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn').replace(/\/+$/, '')
const ENV_PATH = '/opt/pm-app/.env'

// ── 认证 ────────────────────────────────────────────────────────────────────
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
const H = { Authorization: `Bearer ${token}` }

const api = async (path) => {
  const res = await fetch(`${BASE}/api${path}`, { headers: H })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 忽略 */
  }
  return { status: res.status, json }
}

// ── 动态路由真实 id 采样 ────────────────────────────────────────────────────
async function pickRealIds() {
  const out = { projectId: null, phaseId: null, taskId: null, notes: [] }
  const r = await api('/projects?page=1&limit=10')
  if (r.status !== 200 || !r.json?.data?.items?.length) {
    out.notes.push(`GET /api/projects 异常(status=${r.status})，动态路由页面将用占位 id`)
    return out
  }
  for (const p of r.json.data.items) {
    const t = await api(`/tasks?projectId=${p.id}&page=1&limit=1`)
    // okPage 结构: data.items + data.pagination.total
    const tTotal = t.json?.data?.pagination?.total ?? t.json?.data?.total ?? 0
    if (t.status === 200 && tTotal > 0) {
      out.projectId = p.id
      out.projectName = p.name
      out.taskId = t.json.data.items[0].id
      const tree = await api(`/projects/${p.id}/tree`)
      if (tree.status === 200 && tree.json?.data?.phases?.length) {
        out.phaseId = tree.json.data.phases[0].id
      } else if (t.json.data.items[0].phase?.id) {
        out.phaseId = t.json.data.items[0].phase.id
      }
      return out
    }
  }
  // 无任何项目有任务：退回第一个项目，任务页标注 SKIP
  const first = r.json.data.items[0]
  out.projectId = first.id
  out.projectName = first.name
  out.notes.push(`所有项目均无任务（尝试了 ${r.json.data.items.length} 个），/projects/[id]/tasks/[taskId] 页面将 SKIP`)
  const tree = await api(`/projects/${first.id}/tree`)
  if (tree.status === 200 && tree.json?.data?.phases?.length) {
    out.phaseId = tree.json.data.phases[0].id
  }
  return out
}

// ── 页面断言 ────────────────────────────────────────────────────────────────
const BAD_MARKERS = ['Application error', 'This page could not be found']
async function checkPage(path, { auth = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: auth ? H : {},
    redirect: 'follow',
  })
  const html = await res.text()
  const status = res.status
  const notes = []
  let pass = true
  if (status !== 200) {
    pass = false
    notes.push(`状态码 ${status}`)
  }
  // 剥离内联脚本（含 RSC flight 数据）后只在可见 DOM/标题中找错误标记
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  const bad = BAD_MARKERS.filter((m) => visible.includes(m))
  if (bad.length) {
    pass = false
    notes.push(`含错误标记 ${bad.join('/')}`)
  }
  // root 挂载点: Pages Router 是 <div id="__next">, App Router 是 <body> 壳
  if (!/<div id="__next"|<body[\s>]/i.test(html)) {
    pass = false
    notes.push('缺少 root 挂载点')
  }
  if (res.redirected) notes.push(`重定向到 ${res.url}`)
  return { path, status, pass, note: notes.join('; ') || '—' }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log(`# QA B1-L1 页面冒烟  target=${BASE}  time=${new Date().toISOString()}`)
const ids = await pickRealIds()
console.log(
  `# 动态路由采样: projectId=${ids.projectId}(${ids.projectName ?? '?'}) phaseId=${ids.phaseId} taskId=${ids.taskId}`,
)
for (const n of ids.notes) console.log(`# NOTE: ${n}`)
console.log('')

const authedPages = [
  '/',
  '/projects',
  '/projects/new',
  '/projects/[id]',
  '/projects/[id]/phases/[phaseId]',
  '/projects/[id]/tasks/[taskId]',
  '/tasks',
  '/process-templates',
  '/purchase',
  '/files',
  '/messages',
  '/organization',
  '/organization/externals',
  '/organization/job-titles',
  '/settings',
  '/help',
  '/views/charts',
  '/views/flow',
  '/views/gantt',
  '/views/table',
]
const anonPages = ['/login', '/register', '/forgot-password']

const fill = (tpl) =>
  tpl
    .replace('[id]', ids.projectId ?? 'SKIP-NOPROJECT')
    .replace('[phaseId]', ids.phaseId ?? 'SKIP-NOPHASE')
    .replace('[taskId]', ids.taskId ?? 'SKIP-NOTASK')

const results = []
for (const tpl of authedPages) {
  const path = fill(tpl)
  if (/SKIP-/.test(path)) {
    results.push({
      path: `${tpl} → ${path}`,
      status: '-',
      pass: null,
      note: `SKIP: ${path.includes('NOPROJECT') ? '无项目' : path.includes('NOPHASE') ? '项目无阶段' : '项目无任务'}`,
    })
    continue
  }
  results.push(await checkPage(path, { auth: true }))
}
for (const p of anonPages) results.push(await checkPage(p, { auth: false }))

// ── 输出 ────────────────────────────────────────────────────────────────────
const pad = (s, w) => String(s).padEnd(w, '　' === '　' ? ' ' : ' ')
const w = [46, 6, 4, 40]
console.log(`${pad('页面', w[0])}|${pad('状态码', w[1])}|${pad('判定', w[2])}|备注`)
console.log(`${'-'.repeat(w[0])}|${'-'.repeat(w[1])}|${'-'.repeat(w[2])}|${'-'.repeat(w[3])}`)
for (const r of results) {
  const verdict = r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'
  console.log(
    `${pad(r.path, w[0])}|${pad(r.status, w[1])}|${pad(verdict, w[2])}|${r.note}`,
  )
}

const total = results.length
const passN = results.filter((r) => r.pass === true).length
const failN = results.filter((r) => r.pass === false).length
const skipN = results.filter((r) => r.pass === null).length
console.log('')
console.log(`汇总: ${passN}/${total} PASS, ${failN} FAIL, ${skipN} SKIP`)
process.exit(failN > 0 ? 1 : 0)
