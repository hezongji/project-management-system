/**
 * GET /api/im/voice/[uuid] —— 语音读取（v1.2 W1）
 *
 * requireAuth + uuid 格式白名单（防路径穿越）→ im-voice/{uuid}.{ext} → 字节流
 * 前端 fetch→blob→objectURL（Bearer 鉴权，<audio src> 直链必 401）
 */

import { NextRequest } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { apiHandler, requireAuth, ApiError } from '@/lib/api-helpers'
import { fileRoot } from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: Promise<{ uuid: string }> }

export const GET = apiHandler<Ctx>(async (_request: NextRequest, { params }) => {
  const user = requireAuth(_request)
  if (!user) throw ApiError.unauthorized('未认证')

  const { uuid } = await params
  if (!UUID_RE.test(uuid)) {
    throw ApiError.badRequest('无效的语音标识')
  }

  const dir = path.join(fileRoot(), 'im-voice')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    entries = []
  }
  const match = entries.find((e) => e.startsWith(uuid + '.'))
  if (!match) throw ApiError.notFound('语音不存在')

  const buf = await fs.readFile(path.join(dir, match))
  const ext = path.extname(match).toLowerCase()
  const contentType = ext === '.ogg' ? 'audio/ogg' : ext === '.m4a' ? 'audio/mp4' : ext === '.mp3' ? 'audio/mpeg' : 'audio/webm'

  const { NextResponse } = await import('next/server')
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=3600',
    },
  })
})
