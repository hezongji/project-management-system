// next 14→16 codemod: params Promise 化
// 用法: node scripts/next16-params-codemod.cjs
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name === 'route.ts') out.push(p)
  }
  return out
}

function findMatchingBrace(s, openIdx) {
  let depth = 0, inStr = null
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i], prev = s[i - 1]
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

const files = walk(path.join(ROOT, 'src/app/api'))
let stats = { files: 0, aliases: 0, handlersA: 0, handlersB: 0, inline: 0 }
const touched = []

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8')
  if (!/\bparams\b/.test(s)) continue
  const orig = s

  // 1. 类型别名/内联类型: { params: { ... } } → { params: Promise<{ ... }> }
  s = s.replace(/(\{\s*params\s*:\s*)(\{[^{}]*\})/g, (m, a, b) => {
    stats.aliases++
    return a + 'Promise<' + b + '>'
  })

  // 2. 逐 handler 处理
  const sigRe = /async\s*\(([^()]*)\)\s*=>/g
  let m
  const edits = []
  while ((m = sigRe.exec(s)) !== null) {
    const sig = m[1]
    const arrowEnd = m.index + m[0].length
    // 找函数体起始 {
    const bodyOpen = s.indexOf('{', arrowEnd)
    if (bodyOpen === -1) continue
    const bodyClose = findMatchingBrace(s, bodyOpen)
    if (bodyClose === -1) continue
    const body = s.slice(bodyOpen + 1, bodyClose)

    const isA = /\{\s*params\s*(?::[^}]*)?\}/.test(sig)
    const isB = /\bcontext\s*:/.test(sig) && !isA
    if (!isA && !isB) continue

    const usageRe = isB ? /context\.params\.(\w+)/g : /\bparams\.(\w+)/g
    const keys = new Set()
    let um
    while ((um = usageRe.exec(body)) !== null) keys.add(um[1])
    if (keys.size === 0) continue

    let newBody = body
    for (const k of keys) {
      newBody = isB
        ? newBody.split('context.params.' + k).join(k)
        : newBody.replace(new RegExp('\\bparams\\.' + k + '\\b', 'g'), k)
    }
    const awaitLine = isB
      ? `  const { ${[...keys].join(', ')} } = await context.params`
      : `  const { ${[...keys].join(', ')} } = await params`
    newBody = '\n' + awaitLine + body
    edits.push({ bodyOpen: bodyOpen + 1, bodyClose, newBody })
    isB ? stats.handlersB++ : stats.handlersA++
  }
  // 倒序应用避免位移
  for (const e of edits.sort((a, b) => b.bodyOpen - a.bodyOpen)) {
    s = s.slice(0, e.bodyOpen) + e.newBody + s.slice(e.bodyClose)
  }
  if (s !== orig) {
    fs.writeFileSync(file, s)
    stats.files++
    touched.push(path.relative(ROOT, file))
  }
}
console.log('files:', stats.files, 'typeAliases:', stats.aliases, 'handlers(destructure):', stats.handlersA, 'handlers(context):', stats.handlersB)
console.log(touched.join('\n'))
