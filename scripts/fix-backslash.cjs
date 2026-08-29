/**
 * fix-backslash.cjs —— Next.js Windows 构建反斜杠路径修复
 *
 * 问题：Next.js 14 在 Windows 上构建 standalone 时，.next/server 的页面 chunk 里
 * 模块 require 路径会写成分隔符反斜杠（如 require("next\\dist\\client\\...")，
 * 即文件字节为双反斜杠 \\；不同构建可能产生 2 或 4 层反斜杠）。
 * 部署到 Linux 后 Node 无法解析这种路径（Linux 用正斜杠 /）→ Cannot find module。
 *
 * 修复：把 require("...") 内的连续反斜杠（1 个或多个 \ 字符）全部替换为正斜杠 /，
 * 并去掉因此产生的 .js 后缀冗余（next/dist/client/components/x.external.js → .external）。
 * 挂到 npm postbuild：每次构建后自动执行，部署产物即已修复。
 *
 * 只在 Windows 构建产物上生效；Linux 上构建不会产生此问题（脚本自动跳过）。
 */
const fs = require('fs')
const path = require('path')

const serverDirs = [
  path.join(__dirname, '..', '.next', 'server'),
  // standalone 副本：build 时从 .next 快照，postbuild 修复需同时覆盖
  path.join(__dirname, '..', '.next', 'standalone', '.next', 'server'),
]

function main() {
  let fixed = 0
  let scanned = 0
  let anyDir = false

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.js')) {
        scanned++
        let s = fs.readFileSync(p, 'utf8')
        const orig = s
        // require("...") 内的连续反斜杠（1 个或多个 \ 字符）→ 正斜杠 /
        s = s.replace(/require\("([^"]*)"\)/g, (m, inner) => {
          if (!inner.includes('\\')) return m
          const fixedInner = inner
            .replace(/\\+/g, '/')
            // 去掉 external.js 的错误 .js 后缀（正确模块名不含 .js）
            .replace(/\.external\.js"/, '.external"')
            .replace(/\.external\.js$/, '.external')
          return 'require("' + fixedInner + '")'
        })
        if (s !== orig) {
          fs.writeFileSync(p, s)
          fixed++
        }
      }
    }
  }
  for (const dir of serverDirs) {
    if (fs.existsSync(dir)) {
      anyDir = true
      walk(dir)
    }
  }
  if (!anyDir) {
    console.log('[fix-backslash] 未找到 .next/server，跳过')
    return
  }
  console.log(`[fix-backslash] 扫描 ${scanned} 个 chunk，修复 ${fixed} 个（平台: ${process.platform}）`)
}

main()
