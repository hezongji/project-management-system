#!/usr/bin/env node
/**
 * scripts/test-notify.mjs —— Webhook 通知最小测试脚本（P2-2）
 *
 * 用途：验证企业微信 / 钉钉群机器人 webhook 配置是否正确。
 *
 * 用法：
 *   # 直接传环境变量
 *   WECOM_WEBHOOK_URL='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' \
 *   node scripts/test-notify.mjs
 *
 *   # 或写入 .env（脚本会自动读取 .env 里的两个 webhook 键）
 *   node scripts/test-notify.mjs
 *
 *   # 自定义消息正文（可选）
 *   node scripts/test-notify.mjs '这是一条自定义测试消息'
 *
 * 退出码：0=全部成功（或未配置）；非 0=存在发送失败。
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 .env 解析：仅提取 WECOM_WEBHOOK_URL / DINGTALK_WEBHOOK_URL */
function readEnv() {
  const env = { ...process.env }
  try {
    const raw = readFileSync(resolve(ROOT, '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(WECOM_WEBHOOK_URL|DINGTALK_WEBHOOK_URL)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in env)) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // 无 .env 忽略
  }
  return env
}

/** 发送一条 markdown 并解析响应 */
async function send(provider, url, title, content) {
  const payload =
    provider === 'wecom'
      ? { msgtype: 'markdown', markdown: { content: `# ${title}\n\n${content}` } }
      : { msgtype: 'markdown', markdown: { title, text: content } }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const body = await res.text()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null
    }
    const ok = res.status >= 200 && res.status < 300 && (!parsed || parsed.errcode === 0)
    return {
      ok,
      detail: parsed ? `errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? ''}` : `HTTP ${res.status} ${body.slice(0, 80)}`,
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

const env = readEnv()
const wecom = env.WECOM_WEBHOOK_URL?.trim()
const dingtalk = env.DINGTALK_WEBHOOK_URL?.trim()

const customText = process.argv[2]?.trim()
const ts = new Date().toLocaleString('zh-CN', { hour12: false })

console.log('Webhook 通知测试（P2-2）')
console.log('------------------------')

if (!wecom && !dingtalk) {
  console.log('⚠ 未配置 WECOM_WEBHOOK_URL / DINGTALK_WEBHOOK_URL，静默跳过（退出码 0）。')
  process.exit(0)
}

const content = customText
  ? `**测试消息**：${customText}\n**时间**：${ts}`
  : `**这是一条来自 PM 系统的测试通知**\n**时间**：${ts}`

let failed = 0
const results = await Promise.all(
  [
    wecom && { provider: 'wecom', url: wecom },
    dingtalk && { provider: 'dingtalk', url: dingtalk },
  ]
    .filter(Boolean)
    .map(async (t) => {
      const r = await send(t.provider, t.url, 'PM 通知测试', content)
      console.log(`${r.ok ? '✅' : '❌'} ${t.provider}: ${r.detail}`)
      if (!r.ok) failed++
    }),
)
await results

console.log('------------------------')
console.log(failed === 0 ? '全部发送成功 ✅' : `存在 ${failed} 个发送失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
