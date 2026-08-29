#!/usr/bin/env node
/**
 * ★ B5-质检驾驶舱 CLI 编排器（2026-08-25 QA 战役收官沉淀）
 *
 * 用法：
 *   node scripts/qa/run-cockpit.mjs                        # 六维度全跑
 *   node scripts/qa/run-cockpit.mjs --dims smoke,perm      # 只跑指定维度
 *   node scripts/qa/run-cockpit.mjs --base https://pm.hezongji.cn/api
 *
 * 行为：顺序执行六脚本（单个失败继续后续）；每脚本记录 exitCode/stdout 末3行/耗时；
 *       汇总追加 scripts/qa/qa-runs.json（保留最近 50 条，与 /api/admin/qa-cockpit 共用格式）；
 *       末尾打印总表，整体退出码 = 是否全部成功（0=全绿）。
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const QA_DIR = path.dirname(fileURLToPath(import.meta.url))
const RUNS_FILE = path.join(QA_DIR, 'qa-runs.json')
const SCRIPT_TIMEOUT_MS = 300_000
const MAX_RUNS = 50

// 维度 key → 脚本（相对本目录；与 api/admin/qa-cockpit/route.ts 保持一致，勿单边改名）
// purchase 脚本历史原因位于 scripts/ 根目录，以 ../ 引用避免复制两份
const DIM_SCRIPTS = {
  smoke: 'smoke-pages.mjs',
  perm: 'perm-matrix.mjs',
  project: 'b2-project-chain.mjs',
  file: 'b2-file-urge-chain.mjs',
  im: 'b2-im-notify-chain.mjs',
  purchase: '../purchase-filter-verify.mjs',
}

// ── 参数解析 ──
const argv = process.argv.slice(2)
const argValue = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const dimsArg = argValue('--dims')
const dims = dimsArg
  ? dimsArg.split(',').map((s) => s.trim()).filter((d) => d in DIM_SCRIPTS)
  : Object.keys(DIM_SCRIPTS)
if (dims.length === 0) {
  console.error(`无有效维度。可用：${Object.keys(DIM_SCRIPTS).join(', ')}`)
  process.exit(2)
}
const BASE = argValue('--base') || 'http://127.0.0.1:3001/api'
// ★ 维度间 BASE 口径差异（按各脚本自身约定，勿统一）：
//   smoke/perm 两脚本约定 BASE=站点根（无 /api 后缀，页面/与 /api 同源拼接）；
//   project/file/im/purchase 四链脚本约定 BASE=API 根（含 /api）。此处自动换算。
const ORIGIN = BASE.replace(/\/api\/?$/, '')
const dimBase = (d) => (d === 'smoke' || d === 'perm' ? ORIGIN : BASE)

// ── 逐脚本执行（spawnSync，失败继续）──
console.log(`\n═══ 质检驾驶舱体检 ═══`)
console.log(`BASE=${BASE}  维度=[${dims.join(', ')}]\n`)
const results = {}
for (const dim of dims) {
  const script = DIM_SCRIPTS[dim]
  const started = Date.now()
  const r = spawnSync('node', [path.join(QA_DIR, script)], {
    env: { ...process.env, BASE: dimBase(dim) },
    cwd: QA_DIR,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT_MS,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
  const exitCode = r.status ?? (r.signal ? 124 : 1) // 超时 SIGTERM → 124
  results[dim] = { exitCode, tail, durationMs: Date.now() - started }
  console.log(`[${exitCode === 0 ? '✓' : '✗'}] ${dim.padEnd(9)} ${String(results[dim].durationMs).padStart(6)}ms  ${tail}`)
}

// ── 写入 qa-runs.json（追加，保留最近 50 条）──
const run = {
  id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  startedAt: new Date().toISOString(),
  durationMs: Object.values(results).reduce((a, b) => a + b.durationMs, 0),
  triggeredBy: 'cli',
  base: BASE,
  dims: results,
  okDims: dims.filter((d) => results[d].exitCode === 0).length,
  totalDims: dims.length,
}
let runs = []
try {
  runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'))
} catch {
  /* 首次运行文件不存在，从空数组开始 */
}
runs.push(run)
fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-MAX_RUNS), null, 2), 'utf8')

// ── 总表 ──
console.log(`\n────────── 汇总 ──────────`)
console.log(`${run.okDims}/${run.totalDims} 维度健康 · 总耗时 ${(run.durationMs / 1000).toFixed(1)}s · 已记录 ${run.id}`)
console.log(run.okDims === run.totalDims ? '全部通过 ✅' : '存在失败维度 ❌（详见上方每行 tail）')
process.exit(run.okDims === run.totalDims ? 0 : 1)
