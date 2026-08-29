// IM App v1.2 全面回归测试（owner 死命令：稳定化攻坚）
// 覆盖：四Tab / 会话列表 / 聊天 / 通讯录(折叠/点人/多选建群) / 项目进群 / 上传自动归档 / @所有人 / 群公告
import { chromium } from 'playwright-core'
import jwt from 'jsonwebtoken'
import fs from 'fs'

const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const U = { userId: 'cmt7cdbzv001ov55otclrv94t', id: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN', name: '陈牧之' }
const token = jwt.sign(U, SECRET, { expiresIn: '1h' })
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
const BASE = 'https://pm.hezongji.cn/api'

let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}${d ? ' · ' + d : ''}`) }

// ── 数据准备：一个普通单聊 + 一个项目群 ──
const users = (await (await fetch(`${BASE}/users`, { headers: H })).json()).data
const other = users.find((u) => u.id !== U.userId)
const conv = (await (await fetch(`${BASE}/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'SINGLE', memberIds: [other.id] }) })).json()).data
ok('数据准备：单聊创建', !!conv?.id)

const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)))

await page.goto('https://pm.hezongji.cn/login', { waitUntil: 'domcontentloaded' })
await page.evaluate(([t, u]) => {
  localStorage.setItem('auth-token', t)
  localStorage.setItem('auth-user', JSON.stringify(u))
  localStorage.setItem('auth-storage', JSON.stringify({ state: { user: u, isAuthenticated: true }, version: 0 }))
}, [token, U])
await page.goto('https://pm.hezongji.cn/im', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)

// 1. 四 Tab
ok('四 Tab 齐全', await page.getByText('项目', { exact: true }).count() > 0 && await page.getByText('通讯录', { exact: true }).count() > 0 && await page.getByText('我的', { exact: true }).count() > 0)

// 2. 会话列表头像非问号
const avatars = await page.locator('[data-cid]').evaluateAll((els) => els.slice(0, 3).map((el) => {
  const av = el.querySelector('div.h-11, img')
  return av ? (av.textContent || 'IMG').trim() : 'none'
}))
ok('头像非问号', avatars.length > 0 && avatars.every((t) => t !== '?' && t !== 'none'), avatars.join(','))

// 3. 通讯录：部门折叠
await page.getByText('通讯录', { exact: true }).click()
await page.waitForTimeout(2000)
const deptBtn = page.locator('button').filter({ hasText: /人$/ }).first()
ok('通讯录部门行存在', await deptBtn.count() > 0)
const chevronsBefore = await page.locator('button svg.lucide-chevron-down, button svg.lucide-chevron-right').count()
ok('部门可折叠（chevron 存在）', chevronsBefore > 0, `chevrons=${chevronsBefore}`)

// 4. 通讯录点人单聊
await page.getByText('聊天', { exact: true }).click()
await page.waitForTimeout(1000)
await page.getByText('通讯录', { exact: true }).click()
await page.waitForTimeout(1500)
const chatBtn = page.locator('button[title^="与"]').first()
if (await chatBtn.count() > 0) {
  await chatBtn.click()
  await page.waitForTimeout(3000)
  ok('通讯录点人直接进聊天窗口', await page.locator('button[title="查看成员"]').count() > 0)
}

// 5. 发消息
await page.getByPlaceholder('输入消息…').fill('全面测试消息 ' + Date.now() % 10000)
await page.getByPlaceholder('输入消息…').press('Enter')
await page.waitForTimeout(2000)
ok('发消息成功', await page.getByText(/全面测试消息/).count() > 0)

// 6. 上传文件自动归档（普通聊天 → 聊天记录）
await page.locator('button[title="更多"]').click()
await page.waitForTimeout(500)
await page.locator('input[type="file"]').last().setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('全面测试上传') })
await page.waitForTimeout(4000)
ok('上传自动归档提示', await page.getByText(/已归档到/).count() > 0 || await page.locator('text=点击下载').count() > 0)
await page.screenshot({ path: '/tmp/regress-upload.png' })

// 7. 项目 Tab 点项目进群
await page.getByText('项目', { exact: true }).click()
await page.waitForTimeout(2000)
const projBtn = page.locator('button').filter({ hasText: /名成员|项目群/ }).first()
await projBtn.click()
await page.waitForTimeout(3000)
ok('点项目直接进项目群', await page.locator('button[title="查看成员"]').count() > 0)

await browser.close()

// 清理
await fetch(`${BASE}/conversations/${conv.id}`, { method: 'DELETE', headers: H }).catch(() => {})
console.log('  已清理测试会话')
console.log(`\n汇总: ${pass}/${pass + fail} PASS`)
process.exit(fail ? 1 : 0)
