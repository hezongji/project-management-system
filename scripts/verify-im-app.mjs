#!/usr/bin/env node
// W5 · PM 聊天 App 全链验证（2026-08-29）
// 断言链：下载页 200 → APK 直出 MIME/大小 → /im 页面 200 → 登录闭环 200
//   → socket 握手鉴权闭环（无 token 拒连 / 带 token 可连）
// 用法: node scripts/verify-im-app.mjs            # 默认线上
//       BASE=https://YOUR-PM-DOMAIN node scripts/verify-im-app.mjs
import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://YOUR-PM-DOMAIN').replace(/\/+$/, '')
const APK_PATH = process.env.APK || '/downloads/pm-chat-1.6.0.apk'

const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94tv', email: 'chenmuzhi@example.com', role: 'ADMIN' }

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`) }

// 1. 下载页
const r1 = await fetch(BASE + '/download', { redirect: 'manual' })
ok('下载页 /download 200', r1.status === 200, `HTTP ${r1.status}`)
ok('下载页无强制登录重定向', r1.status !== 302 && r1.status !== 307)

// 2. APK 直出
const r2 = await fetch(BASE + APK_PATH)
const ct = r2.headers.get('content-type') || ''
const len = Number(r2.headers.get('content-length') || 0)
ok(`APK ${APK_PATH} 200`, r2.status === 200, `HTTP ${r2.status}`)
ok('APK MIME 正确', ct.includes('application/vnd.android.package-archive'), ct)
ok('APK 大小正常（>1MB）', len > 1024 * 1024, `${(len / 1024 / 1024).toFixed(2)}MB`)

// 3. /im 页面与登录闭环
const r3 = await fetch(BASE + '/im', { redirect: 'manual' })
ok('/im 页面 200', r3.status === 200, `HTTP ${r3.status}`)
const r4 = await fetch(BASE + '/login?next=%2Fim')
ok('/login?next=/im 200', r4.status === 200)

// 4. socket 握手鉴权闭环（与 im-server 契约一致）
// ★ 2026-08-29 修复：前端 WS_URL 原为 .../api/im-socket，socket.io-client 会把路径名当 namespace
//   （im-server 仅默认 '/'）→ Invalid namespace 全断。已改 .env 为 origin（默认 /socket.io）。
await new Promise((resolve) => {
  const s1 = io(BASE, { transports: ['websocket'], timeout: 8000 })
  s1.on('connect', () => { ok('socket 无 token 应拒连', false); s1.disconnect(); resolve() })
  s1.on('connect_error', (e) => { ok('socket 无 token 拒连（unauthorized）', e?.message === 'unauthorized', e?.message); s1.disconnect(); resolve() })
  setTimeout(() => { s1.disconnect(); resolve() }, 9000)
})
await new Promise((resolve) => {
  const token = jwt.sign(ADMIN, SECRET, { expiresIn: '1h' })
  const s2 = io(BASE, { auth: { token }, transports: ['websocket'], timeout: 8000 })
  s2.on('connect', () => { ok('socket 带 token 连接成功', true); s2.disconnect(); resolve() })
  s2.on('connect_error', (e) => { ok('socket 带 token 连接成功', false, e?.message); s2.disconnect(); resolve() })
  setTimeout(() => { s2.disconnect(); resolve() }, 9000)
})

console.log(`\n汇总: ${pass}/${pass + fail} PASS`)
process.exit(fail ? 1 : 0)
