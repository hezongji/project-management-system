/**
 * zip 流式打包（20260830-drive-war W2）
 *
 * archiver@7（CJS callable 工厂；v8 改纯 ESM 弃用）。@types/archiver 未提供默认签名——
 * 以最小接口桥接（append/finalize/on）。
 * ★ 用 createRequire 而非裸 require：webpack 会改写裸 require 导致 CJS callable 变命名空间对象
 *   （线上事故验证）；createRequire 无法被静态分析，保持运行时原生语义。
 */

import { createRequire } from 'module'

const req = createRequire(import.meta.url)
const archiver = req('archiver') as unknown as (
  format: 'zip',
  options?: { zlib?: { level?: number } },
) => {
  append: (source: NodeJS.ReadableStream, opts: { name: string }) => void
  finalize: () => Promise<void>
  on: (event: 'data' | 'end' | 'error', listener: (...args: never[]) => void) => void
}

export function createZipStream(level = 3) {
  return archiver('zip', { zlib: { level } })
}
