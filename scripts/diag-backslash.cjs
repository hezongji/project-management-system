// 诊断 .next/server 里 require 路径的反斜杠形式
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', '.next', 'server')
let sample = null
let count = 0
let doubleBS = 0
let singleBS = 0

function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8')
      // 找 require("...") 含 next\dist 的
      const re = /require\("([^"]*next[^"]*)"\)/g
      let m
      while ((m = re.exec(s))) {
        const inner = m[1]
        if (inner.includes('\\')) {
          count++
          // 检查是双反斜杠（\\）还是单反斜杠（\）
          if (inner.includes('\\\\')) doubleBS++
          else singleBS++
          if (!sample) sample = inner
        }
      }
    }
  }
}
walk(root)
console.log('含反斜杠 require 总数:', count)
console.log('双反斜杠(\\\\转义)数:', doubleBS)
console.log('单反斜杠数:', singleBS)
console.log('示例:', sample ? JSON.stringify(sample.slice(0, 80)) : '无')
