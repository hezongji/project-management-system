/**
 * 文件存储助手 —— 依据《开发文档-项目管理系统重构》§3.1 / §5 / §7.7
 *
 * 职责：文件落盘/读盘/校验/流式响应的统一入口，供文件上传（submit/upload）、
 * 下载（download）、预览（preview）路由复用，避免各路由重复实现。
 *
 * §3.1 环境变量（通过 env 注入，禁止硬编码）：
 *   FILE_ROOT            文件卷根目录（默认本地 uploads/）
 *   FILE_MAX_SIZE        单文件上限（默认 100MB）
 *   FILE_QUOTA_PER_PROJECT 项目配额（默认 10GB）
 *
 * §5 File.storagePath = {FILE_ROOT}/{projectId}/{catalogId}/{uuid}.{ext}
 *
 * 工程决策（文档未明示处，均可在 P2-2 报告中追溯）：
 *   - DB 的 storagePath 存【相对 FILE_ROOT 的路径】（{projectId}/{catalogId}/{uuid}.{ext}），
 *     读盘时用 resolveStoredFile() 拼回 FILE_ROOT。存相对路径使文件卷迁移/换盘后
 *     记录仍有效（存绝对路径会随 FILE_ROOT 变化失效）。
 *   - mimeType 校验：若环境未配置 ALLOWED_FILE_TYPES，接受任意合法 MIME
 *     （PM 系统需承载 dwg/docx/xlsx 等非文档白名单类型，§3.1 亦未定义允许清单）；
 *     配置了则严格按白名单放行。
 *   - sha256 在写盘前对内存 Buffer 计算，与落盘字节一致；上传与下载均校验存在。
 *   - 下载/预览支持 HTTP Range（206 分段），流式返回，避免整文件进内存。
 */

import { createHash, randomUUID } from 'crypto'
import { promises as fs, createReadStream } from 'fs'
import { Readable } from 'stream'
import path from 'path'
import { prisma } from './prisma'
import type { Prisma } from '@prisma/client'

// ───────────────────────────── 配置 ─────────────────────────────

const DEFAULT_FILE_ROOT = path.join(process.cwd(), 'uploads')
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024 // 100MB（§3.1）
const DEFAULT_QUOTA = 10 * 1024 * 1024 * 1024 // 10GB（§3.1）

export interface FileConfig {
  root: string
  maxSize: number
  quotaPerProject: number
}

/** FILE_ROOT：优先 env，缺省回退本地 uploads/（§3.1「默认本地 uploads/ 目录」） */
export function fileRoot(): string {
  const env = process.env.FILE_ROOT
  if (env && env.trim()) return path.resolve(env.trim())
  return DEFAULT_FILE_ROOT
}

/** 文件相关环境配置（§3.1） */
export function fileConfig(): FileConfig {
  const maxSize = Number(process.env.FILE_MAX_SIZE)
  const quota = Number(process.env.FILE_QUOTA_PER_PROJECT)
  return {
    root: fileRoot(),
    maxSize: Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_MAX_SIZE,
    quotaPerProject:
      Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_QUOTA,
  }
}

// ───────────────────────────── 基础工具 ─────────────────────────────

const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

/** 允许的 MIME 白名单（env 配置时生效；未配置返回 true 放行） */
export function isAllowedMime(mimeType: string): boolean {
  if (!mimeType || !MIME_RE.test(mimeType)) return false
  const allowed = process.env.ALLOWED_FILE_TYPES
  if (!allowed || !allowed.trim()) return true
  const set = allowed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return set.length === 0 || set.includes(mimeType.toLowerCase())
}

/** 扩展名：优先取原文件名的最后一个点后段，非法/缺失时按 mimeType 回退 */
export function extFor(filename: string, mimeType: string): string {
  const fromName = path.extname(filename || '').replace(/^\./, '').toLowerCase()
  if (fromName && /^[a-z0-9]{1,10}$/.test(fromName)) return fromName
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/plain': 'txt',
  }
  return map[mimeType.toLowerCase()] ?? 'bin'
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** sha256（hex）—— §7.7 上传校验；写盘前后字节一致 */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 目录相对路径：{projectId}/{catalogId}（§5 storagePath 前缀；统一正斜杠，跨平台可移植） */
export function storageDir(projectId: string, catalogId: string): string {
  return `${projectId}/${catalogId}`
}

/**
 * 写盘：{FILE_ROOT}/{projectId}/{catalogId}/{uuid}.{ext}
 * @returns 相对 FILE_ROOT 的 storagePath（存 DB）与绝对路径（供读盘）
 */
export async function writeUploadFile(
  projectId: string,
  catalogId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ storagePath: string; absolutePath: string; size: number }> {
  const { root } = fileConfig()
  const ext = extFor(filename, mimeType)
  const uuid = randomUUID()
  const relDir = storageDir(projectId, catalogId)
  const absDir = path.join(root, relDir)
  await ensureDir(absDir)
  const rel = `${relDir}/${uuid}.${ext}`
  const abs = path.join(root, rel)
  await fs.writeFile(abs, buffer)
  return { storagePath: rel, absolutePath: abs, size: buffer.byteLength }
}

/** 读盘：相对 storagePath → 绝对路径；越界（..）拒绝返回 null */
export function resolveStoredFile(storagePath: string): string | null {
  const { root } = fileConfig()
  const abs = path.resolve(root, storagePath || '')
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** 项目已用字节（配额校验用；2026-08-22 P2-2 修复：SQL 聚合代替全表拉取 JS 累加） */
export async function projectUsedBytes(projectId: string, tx?: Prisma.TransactionClient): Promise<number> {
  const agg = await (tx ?? prisma).file.aggregate({
    where: { projectId },
    _sum: { size: true },
  })
  return agg._sum.size ?? 0
}

// ───────────────────────────── 流式响应（下载/预览共用） ─────────────────────────────

export interface StreamFileOptions {
  mimeType: string
  /** 下载名（Content-Disposition filename） */
  filename: string
  /** true=inline（预览）；false=attachment（下载） */
  inline?: boolean
  /** 原始 Range 请求头（如 bytes=0-1023） */
  range?: string | null
}

/** 解析 Range 头 → {start, end}；非法/空返回 null（整文件 200） */
export function parseRange(range: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!range || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m) return null
  const [, s, e] = m
  if (s === '' && e === '') return null
  let start: number
  let end: number
  if (s === '') {
    // 后缀范围 bytes=-N → 最后 N 字节
    const n = parseInt(e, 10)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = parseInt(s, 10)
    if (!Number.isFinite(start) || start < 0) return null
    end = e === '' ? size - 1 : parseInt(e, 10)
    if (!Number.isFinite(end) || end < start) return null
    end = Math.min(end, size - 1)
  }
  if (start >= size) return null
  return { start, end }
}

/**
 * 流式返回文件（含 Range 分段 206 支持，§7.7「流式下载/预览」）。
 * 用 fs.createReadStream + Readable.toWeb 桥接为 web ReadableStream，
 * 逐块读取不整文件进内存。
 */
export async function streamFile(absPath: string, opts: StreamFileOptions): Promise<Response> {
  let stat: { size: number }
  try {
    stat = await fs.stat(absPath)
  } catch {
    return new Response('文件不存在或已被移动', { status: 404 })
  }

  const disposition = opts.inline ? 'inline' : 'attachment'
  // RFC 5987 编码中文文件名，防止下载名乱码
  const encoded = encodeURIComponent(opts.filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  const baseHeaders: Record<string, string> = {
    'Content-Type': opts.mimeType,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encoded}`,
    'Accept-Ranges': 'bytes',
  }

  const range = parseRange(opts.range, stat.size)
  if (range) {
    const { start, end } = range
    const length = end - start + 1
    const nodeStream = createReadStream(absPath, { start, end })
    const webStream = Readable.toWeb(nodeStream) as ReadableStream
    return new Response(webStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      },
    })
  }

  const nodeStream = createReadStream(absPath)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream
  return new Response(webStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
  })
}
