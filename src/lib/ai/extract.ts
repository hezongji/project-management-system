/**
 * 严格 JSON 抽取（纯函数，零依赖）
 *
 * MiMo 偶发在 JSON 前后带说明文字/围栏，先用整体 parse，失败再定位首个平衡数组/对象兜底。
 */

function stripFences(text: string): string {
  // 去掉 ```json ... ``` 围栏（模型偶发输出）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

/** 定位首个完整 JSON 数组（平衡括号扫描，跳过字符串内的括号与转义） */
export function extractJsonArray(text: string): unknown[] | null {
  const parsed = parseFirst(text, '[')
  return Array.isArray(parsed) ? parsed : null
}

/** 定位首个完整 JSON 对象（平衡括号扫描，跳过字符串内的括号与转义） */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const parsed = parseFirst(text, '{')
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function parseFirst(text: string, open: '[' | '{'): unknown | null {
  const src = stripFences(text)
  // 1) 整体就是合法 JSON
  try {
    const whole = JSON.parse(src)
    if (open === '[' ? Array.isArray(whole) : typeof whole === 'object' && whole !== null) return whole
  } catch {
    // 继续兜底
  }
  // 2) 扫描首个平衡的 [ ] / { }
  const close = open === '[' ? ']' : '}'
  const start = src.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      if (inStr) esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
