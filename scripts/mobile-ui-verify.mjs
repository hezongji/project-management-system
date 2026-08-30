#!/usr/bin/env node
// SDLC 20260830-mobile-ui · S4 验收脚本（A1-A6）
// A1 375px 核心页无横向滚动  A2 底部Tab存在且4项  A3 触控尺寸抽查
// A4 /im 无重复Tab  A5 1280px 桌面回归(无TabBar+侧边栏在)  A6 /messages 移动端重定向 /im
// 用法: node scripts/mobile-ui-verify.mjs
import { chromium } from 'playwright-core'
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'https://pm.hezongji.cn').replace(/\/+$/, '')
const CHROME = process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
const SHOTS = '/opt/pm-app/.sdlc/active/20260830-mobile-ui/shots'
fs.mkdirSync(SHOTS, { recursive: true })

const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')
const U = { userId: 'cmt7cdbzv001ov55otclrv94tv', id: 'cmt7cdbzv001ov55otclrv94tv', email: 'chenmuzhi@example.com', role: 'ADMIN', name: '陈牧之' }
const token = jwt.sign(U, SECRET, { expiresIn: '1h' })

let pass = 0, fail = 0
const results = []
const ok = (id, name, cond, detail = '') => {
  cond ? pass++ : fail++
  results.push({ id, name, pass: !!cond, detail })
  console.log(`${cond ? '✅' : '❌'} [${id}] ${name}${detail ? ' · ' + detail : ''}`)
}

const injectAuth = async (page) => {
  await page.evaluate(([t, u]) => {
    localStorage.setItem('auth-token', t)
    localStorage.setItem('auth-user', JSON.stringify(u))
    localStorage.setItem('auth-storage', JSON.stringify({ state: { user: u, isAuthenticated: true }, version: 0 }))
  }, [token, U])
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })

// ══════════ 移动端 375px ══════════
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 100)))
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await injectAuth(page)

  // A1 + A2 + A3(主按钮抽查)：核心页面
  const pages = [
    ['/', '工作台'], ['/projects', '项目列表'], ['/tasks', '任务'], ['/todos', '待办'],
    ['/purchase', '采购'], ['/files', '文件'], ['/organization', '组织'],
    ['/settings', '设置'], ['/help', '帮助'],
  ]
  for (const [path, label] of pages) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(2600)
    // A1 无横向滚动
    const sw = await page.evaluate(() => document.documentElement.scrollWidth)
    ok('A1', `${label}(${path}) 无横向滚动`, sw <= 376, `scrollWidth=${sw}`)
    // A2 TabBar 存在且 4 项
    if (path === '/') {
      const tabInfo = await page.evaluate(() => {
        const nav = document.querySelector('[data-mobile-tabbar]')
        if (!nav) return null
        const items = nav.querySelectorAll('a, button')
        return { count: items.length, h: items[0]?.offsetHeight ?? 0, visible: !!nav.offsetParent || getComputedStyle(nav).position === 'fixed' }
      })
      ok('A2', '底部 TabBar 存在且 4 项', !!tabInfo && tabInfo.count === 4, tabInfo ? `items=${tabInfo.count}` : 'tabbar 缺失')
      // A3-1 Tab 项触控高度 ≥44
      ok('A3', 'Tab 项触控高度 ≥44px', !!tabInfo && tabInfo.h >= 44, `h=${tabInfo?.h}`)
      await page.screenshot({ path: SHOTS + '/m-home.png' })
    }
    // A3-2 页面主按钮(渐变主操作)触控抽查
    const btnH = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, a')].find((el) => {
        const s = getComputedStyle(el)
        return s.backgroundImage.includes('linear-gradient') && el.offsetParent !== null && el.offsetHeight > 0
      })
      return b ? b.offsetHeight : null
    })
    if (btnH != null) ok('A3', `${label} 主按钮触控高度 ≥44px`, btnH >= 44, `h=${btnH}`)
    else console.log(`  ⚠️ [A3] ${label} 未找到可见主按钮（跳过）`)
  }
  await page.screenshot({ path: SHOTS + '/m-last.png' })

  // A4 /im 无主 TabBar（IM 有自己的四 Tab）
  await page.goto(BASE + '/im', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3200)
  const imTab = await page.evaluate(() => !!document.querySelector('[data-mobile-tabbar]'))
  ok('A4', '/im 下无主布局 TabBar（防双 Tab）', !imTab, imTab ? '检测到重复 TabBar' : '')
  await page.screenshot({ path: SHOTS + '/m-im.png' })

  // A6 /messages 移动端重定向 /im
  await page.goto(BASE + '/messages', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3000)
  ok('A6', '/messages 移动端重定向 /im', page.url().includes('/im'), page.url())
  await ctx.close()
}

// ══════════ 桌面 1280px 回归 ══════════
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await injectAuth(page)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(2600)
  // A5-1 桌面无 TabBar
  const dTab = await page.evaluate(() => {
    const nav = document.querySelector('[data-mobile-tabbar]')
    return nav ? getComputedStyle(nav).display !== 'none' : false
  })
  ok('A5', '桌面无可见底部 TabBar（回归）', !dTab)
  // A5-2 桌面侧边栏存在
  const side = await page.evaluate(() => {
    const el = document.querySelector('div.fixed.inset-y-0.left-0')
    return el ? getComputedStyle(el).display !== 'none' : false
  })
  ok('A5', '桌面侧边栏存在（回归）', side)
  await page.screenshot({ path: SHOTS + '/d-home.png' })
  await ctx.close()
}

await browser.close()
console.log('\n═══════ 汇总 ═══════')
console.log(`PASS ${pass} · FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
