'use client'

/**
 * 全局 AI 助手面板（2026-08-22 AI 智能助手 §六）
 *
 * 右下角悬浮球 + 抽屉式聊天面板；POST /api/ai/chat（stream:true，SSE 流式逐块渲染）
 * - SSE 事件：{type:'tools',tools[]} → {type:'delta',delta} … → {type:'done'}
 * - 工具循环阶段（无 delta）显示「AI 正在查询数据…」，首块到达后切换为打字机效果
 * - 用原生 fetch 直连（axios 不便读 SSE）；token 取自 localStorage，与 ApiService 同源
 * 快捷指令：汇总我的项目 / 我的待办 / 分解采购清单
 * 权限由后端工具层跟随（visibleXxxFilter），前端不做数据过滤。
 */

import * as React from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { Bot, Loader2, Send, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  toolsUsed?: string[]
}

const QUICK_CHIPS: { label: string; prompt: string }[] = [
  { label: '汇总我的项目', prompt: '汇总我的项目情况，简要列出重点和风险' },
  { label: '我的待办', prompt: '列出我当前未完成的待办事项' },
  { label: '分解采购清单', prompt: '我想创建一张采购订单，请帮我梳理应该先确认哪些信息' },
]

// —— Markdown 渲染（AI 回复 → HTML；GFM 表格 + 换行即 <br>）——
marked.setOptions({ gfm: true, breaks: true })

/** md → 安全 HTML（AI 输出不可信，DOMPurify 防 XSS）*/
function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html)
}

/** 作用域样式：.ai-md 命名空间，颜色全走 shadcn 主题变量（深浅色自适应）*/
const MD_STYLES = `
.ai-md{font-size:12px;line-height:1.65}
.ai-md>:first-child{margin-top:0}
.ai-md>:last-child{margin-bottom:0}
.ai-md p{margin:6px 0}
.ai-md h1,.ai-md h2,.ai-md h3,.ai-md h4{margin:10px 0 4px;font-weight:600;line-height:1.4}
.ai-md h1{font-size:14px}.ai-md h2{font-size:13px}.ai-md h3{font-size:12.5px}.ai-md h4{font-size:12px}
.ai-md ul,.ai-md ol{margin:6px 0;padding-left:18px}
.ai-md li{margin:2px 0}
.ai-md table{border-collapse:collapse;margin:8px 0;width:100%;font-size:11.5px;display:block;overflow-x:auto}
.ai-md th,.ai-md td{border:1px solid hsl(var(--border));padding:4px 8px;text-align:left;vertical-align:top}
.ai-md th{background:hsl(var(--muted));font-weight:600;white-space:nowrap}
.ai-md code{background:hsl(var(--muted));border-radius:4px;padding:1px 4px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px}
.ai-md pre{background:hsl(var(--muted));border:1px solid hsl(var(--border));border-radius:8px;margin:8px 0;padding:8px 10px;overflow-x:auto}
.ai-md pre code{background:none;padding:0}
.ai-md blockquote{border-left:3px solid hsl(var(--border));color:hsl(var(--muted-foreground));margin:6px 0;padding:2px 0 2px 10px}
.ai-md hr{border:0;border-top:1px solid hsl(var(--border));margin:8px 0}
.ai-md a{color:hsl(var(--primary));text-decoration:underline}
.ai-md strong{font-weight:600}
`

/** SSE 流式调用 /ai/chat：逐块回调（onTools/onDelta），返回完整文本 */
async function streamChat(
  history: ChatMsg[],
  onTools: (tools: string[]) => void,
  onDelta: (acc: string) => void,
): Promise<{ content: string; toolsUsed?: string[] }> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : ''
  const base = `${process.env.NEXT_PUBLIC_API_URL || ''}/api`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  try {
    const resp = await fetch(`${base}/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal: ctrl.signal,
    })
    const ct = resp.headers.get('content-type') || ''
    if (!resp.ok || !ct.includes('text/event-stream')) {
      // 非 SSE = 统一错误壳 JSON（鉴权/校验/上游错误等）
      let msg = `请求失败（${resp.status}）`
      try {
        const j = (await resp.json()) as { message?: string }
        if (j?.message) msg = j.message
      } catch {
        /* 非 JSON 壳，保留默认消息 */
      }
      throw new Error(msg)
    }
    const reader = resp.body?.getReader()
    if (!reader) throw new Error('浏览器不支持流式读取，请升级浏览器')
    const decoder = new TextDecoder()
    let buf = ''
    let acc = ''
    let toolsUsed: string[] | undefined
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        let evt: { type?: string; delta?: string; tools?: string[] }
        try {
          evt = JSON.parse(payload)
        } catch {
          continue
        }
        if (evt.type === 'tools' && Array.isArray(evt.tools)) {
          toolsUsed = evt.tools
          onTools(evt.tools)
        } else if (evt.type === 'delta' && evt.delta) {
          acc += evt.delta
          onDelta(acc)
        }
        // type:'done' → 循环自然结束
      }
    }
    return { content: acc, toolsUsed }
  } finally {
    clearTimeout(timer)
  }
}

function AssistantPanelInner() {
  const [open, setOpen] = React.useState(false)
  const [messages, setMessages] = React.useState<ChatMsg[]>([])
  const [input, setInput] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  // 消息列表自动滚底
  React.useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, sending])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || sending) return
    setError(null)
    const history: ChatMsg[] = [...messages, { role: 'user', content }]
    const placeholder: ChatMsg = { role: 'assistant', content: '' }
    setMessages([...history, placeholder])
    setInput('')
    setSending(true)
    try {
      const { content: reply, toolsUsed } = await streamChat(
        history,
        (tools) => setMessages([...history, { ...placeholder, toolsUsed: tools }]),
        (acc) => setMessages([...history, { ...placeholder, content: acc }]),
      )
      const final = reply.trim()
      if (!final) throw new Error('AI 未返回内容，请重试')
      setMessages([...history, { role: 'assistant', content: final, toolsUsed }])
    } catch (err) {
      const msg = err instanceof Error ? err.message : '请求失败，请稍后重试'
      setError(msg)
      setMessages([...history, { role: 'assistant', content: `抱歉，出了点问题：${msg}` }])
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* 悬浮球 */}
      <Button
        type="button"
        size="icon"
        aria-label={open ? '关闭 AI 助手' : '打开 AI 助手'}
        className="fixed bottom-20 right-5 z-50 h-12 w-12 rounded-full shadow-lg lg:bottom-5"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
      </Button>

      {/* 抽屉面板 */}
      {open && (
        <div className="fixed bottom-36 right-5 z-50 flex h-[min(520px,60dvh)] w-[min(92vw,380px)] lg:bottom-20 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl">
          {/* Markdown 作用域样式（仅面板打开时挂载）*/}
          <style dangerouslySetInnerHTML={{ __html: MD_STYLES }} />
          {/* 头部 */}
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">AI 助手</span>
            <span className="text-xs text-muted-foreground">数据已按你的权限过滤</span>
            <button
              type="button"
              aria-label="关闭"
              className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 快捷指令 */}
          <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
            {QUICK_CHIPS.map((c) => (
              <Button
                key={c.label}
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 rounded-full px-3 text-xs"
                disabled={sending}
                onClick={() => send(c.prompt)}
              >
                {c.label}
              </Button>
            ))}
          </div>

          {/* 消息列表 */}
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && !sending && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Bot className="h-8 w-8 opacity-40" />
                <p className="text-sm font-medium text-foreground">你好，我是项目 AI 助手</p>
                <p className="text-[11px] leading-5">我可以：</p>
                <div className="text-left text-[11px] leading-5">
                  ① 查你的项目 / 任务 / 待办 / 采购
                  <br />
                  ② 汇总项目状态与风险
                  <br />
                  ③ 分解采购清单
                  <br />
                  ④ 解读项目文件
                  <br />
                  ⑤ 生成会议纪要（消息页）
                </div>
                <p className="mt-1">点击上方快捷指令快速开始，或直接提问</p>
              </div>
            )}
            {messages.map((m, i) => {
              // 流式占位：最后一条空 assistant 消息 = 工具循环阶段
              const isThinking =
                sending && m.role === 'assistant' && !m.content && i === messages.length - 1
              return (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {isThinking ? (
                    <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      AI 正在查询数据…
                    </div>
                  ) : (
                    <div
                      className={cn(
                        'max-w-[85%] break-words rounded-lg px-3 py-2 text-xs leading-relaxed',
                        m.role === 'user'
                          ? 'whitespace-pre-wrap bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground',
                      )}
                    >
                      {/* AI 回复走 Markdown→HTML（XSS 已净化）；用户消息保持纯文本 */}
                      {m.role === 'user' ? (
                        m.content
                      ) : (
                        <div className="ai-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                      )}
                      {m.role === 'assistant' && m.toolsUsed && m.toolsUsed.length > 0 && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          已查询：{m.toolsUsed.join('、')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}（可重试或换个问法）
              </div>
            )}
          </div>

          {/* 输入区 */}
          <form
            className="flex items-center gap-2 border-t px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入问题，如：我有哪些未完成任务？"
              className="h-9 text-xs"
              disabled={sending}
              maxLength={2000}
            />
            <Button type="submit" size="icon" className="h-9 w-9 shrink-0" disabled={sending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  )
}

/** 懒挂载：避免服务端渲染问题 */
export function AssistantPanel() {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <AssistantPanelInner />
}
