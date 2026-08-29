/**
 * ★ B5-质检驾驶舱 API（2026-08-25 QA 战役收官沉淀）
 *
 * GET  /api/admin/qa-cockpit → { data: { issues, runs, summary } }
 *   - issues: scripts/qa/qa-issues.json 全量（问题台账）
 *   - runs:   scripts/qa/qa-runs.json 最新 10 条（体检历史）
 *   - summary: p0~p3 = 各级别未决（非「已验证」）计数；openCount / verifiedCount
 *
 * POST /api/admin/qa-cockpit
 *   { action: 'run', dims: string[] }        → 逐脚本跑 scripts/qa/*.mjs（≤300s/个），结果追加 qa-runs.json
 *   { action: 'update-issue', id, status }   → 更新台账条目状态（登记/修复中/已验证）
 *
 * 防并发：模块级内存锁（单实例部署有效），运行中 POST run → 409。
 */

import { NextRequest } from 'next/server'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'

// ── 维度间 BASE 口径差异（与 run-cockpit.mjs 保持一致）──
// smoke/perm 脚本约定 BASE=站点根（无 /api）；四链脚本约定 BASE=API 根（含 /api）。自动换算。
function dimBaseFor(dim: string, base: string): string {
  return dim === 'smoke' || dim === 'perm' ? base.replace(/\/api\/?$/, '') : base
}

// ── 路径与常量 ──
// 运行时 cwd=/opt/pm-app（server.js process.chdir + systemd WorkingDirectory 双重保证）。
// 另留 QA_SCRIPTS_DIR 环境变量兜底，防止未来改为 .next/standalone 启动时 scripts/ 不随产物走。
const QA_DIR = process.env.QA_SCRIPTS_DIR
  ? path.resolve(process.env.QA_SCRIPTS_DIR)
  : path.join(process.cwd(), 'scripts', 'qa')
const ISSUES_FILE = path.join(QA_DIR, 'qa-issues.json')
const RUNS_FILE = path.join(QA_DIR, 'qa-runs.json')
const SCRIPT_TIMEOUT_MS = 300_000
const MAX_RUNS = 50
// 维度 key → 脚本文件（相对 QA_DIR；与前端 DIMS、run-cockpit.mjs 保持一致）
// purchase 脚本历史原因位于 scripts/ 根目录（scripts/purchase-filter-verify.mjs），以 ../ 引用避免复制两份
const DIM_SCRIPTS: Record<string, string> = {
  smoke: 'smoke-pages.mjs',
  perm: 'perm-matrix.mjs',
  project: 'b2-project-chain.mjs',
  file: 'b2-file-urge-chain.mjs',
  im: 'b2-im-notify-chain.mjs',
  purchase: '../purchase-filter-verify.mjs',
}
const ISSUE_STATUS = ['登记', '修复中', '已验证'] as const

// ── 内存锁（防并发体检）──
let runInFlight = false

// ── 数据读写 ──
interface DimResult { exitCode: number; tail: string; durationMs: number }
interface QaRun {
  id: string
  startedAt: string
  durationMs: number
  triggeredBy: string
  base: string
  dims: Record<string, DimResult>
  okDims: number
  totalDims: number
}
interface QaIssue {
  id: string
  level: 'P0' | 'P1' | 'P2' | 'P3'
  title: string
  location: string
  status: (typeof ISSUE_STATUS)[number]
  batch: string
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ── GET：台账 + 历史 + 汇总 ──
export const GET = apiHandler(async (request: NextRequest) => {
  // requireAdmin：未认证 throw 401 / 非 ADMIN 或已停用 throw 403（apiHandler 统一转失败壳）
  const trigger = await requireAdmin(request)

  const issues = readJson<QaIssue[]>(ISSUES_FILE, [])
  const allRuns = readJson<QaRun[]>(RUNS_FILE, [])
  const runs = [...allRuns].reverse().slice(0, 10)

  const open = issues.filter((i) => i.status !== '已验证')
  const summary = {
    p0: open.filter((i) => i.level === 'P0').length,
    p1: open.filter((i) => i.level === 'P1').length,
    p2: open.filter((i) => i.level === 'P2').length,
    p3: open.filter((i) => i.level === 'P3').length,
    openCount: open.length,
    verifiedCount: issues.length - open.length,
  }
  return ok({ issues, runs, summary })
})

// ── 单脚本执行：spawn node，捕获 exitCode / stdout 末 3 行 / 耗时 ──
function runScript(script: string, base: string): Promise<DimResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('node', [path.join(QA_DIR, script)], {
      env: { ...process.env, BASE: base },
      cwd: QA_DIR,
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), SCRIPT_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ exitCode: 1, tail: `spawn失败: ${script}`, durationMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = stdout.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
      resolve({ exitCode: code ?? 1, tail, durationMs: Date.now() - started })
    })
  })
}

// ── POST：run / update-issue ──
export const POST = apiHandler(async (request: NextRequest) => {
  const trigger = await requireAdmin(request)

  const body = (await request.json().catch(() => null)) as
    | { action: 'run'; dims?: string[]; base?: string }
    | { action: 'update-issue'; id?: string; status?: string }
    | null
  if (!body?.action) throw ApiError.badRequest('缺少 action')

  // ── 分支1：跑体检 ──
  if (body.action === 'run') {
    if (runInFlight) throw new ApiError(409, '已有体检在执行中', 'CONFLICT')
    const dims = (body.dims ?? Object.keys(DIM_SCRIPTS)).filter((d) => d in DIM_SCRIPTS)
    if (dims.length === 0) throw ApiError.badRequest('无有效维度')

    runInFlight = true
    try {
      const started = Date.now()
      const base = body.base || 'http://127.0.0.1:3001/api'
      const results: Record<string, DimResult> = {}
      for (const d of dims) results[d] = await runScript(DIM_SCRIPTS[d], dimBaseFor(d, base)) // 顺序执行
      const run: QaRun = {
        id: `run-${started}-${Math.random().toString(36).slice(2, 6)}`,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        triggeredBy: trigger.email || trigger.userId,
        base,
        dims: results,
        okDims: dims.filter((d) => results[d].exitCode === 0).length,
        totalDims: dims.length,
      }
      const allRuns = readJson<QaRun[]>(RUNS_FILE, [])
      writeJson(RUNS_FILE, [...allRuns, run].slice(-MAX_RUNS)) // 追加并保留最近 50 条
      return ok({ okDims: run.okDims, totalDims: run.totalDims, runId: run.id })
    } finally {
      runInFlight = false
    }
  }

  // ── 分支2：更新台账状态 ──
  if (body.action === 'update-issue') {
    const { id, status } = body as { id?: string; status?: string }
    if (!id || !status || !ISSUE_STATUS.includes(status as (typeof ISSUE_STATUS)[number])) {
      throw ApiError.badRequest('参数非法（id + status∈登记/修复中/已验证）')
    }
    const issues = readJson<QaIssue[]>(ISSUES_FILE, [])
    const target = issues.find((i) => i.id === id)
    if (!target) throw ApiError.notFound(`问题 ${id} 不存在`)
    target.status = status as QaIssue['status']
    writeJson(ISSUES_FILE, issues)
    return ok({ id, status })
  }

  throw ApiError.badRequest('未知 action')
})
