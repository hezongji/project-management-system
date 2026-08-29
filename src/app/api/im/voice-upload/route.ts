/**
 * POST /api/im/voice-upload —— 语音消息上传（v1.2 W1）
 *
 * multipart(file + duration) → im-voice/{uuid}.{ext}
 *   - requireAuth；≤2MB；audio mime 白名单（webm/ogg/mp4/mpeg）
 *   - 语音是聊天内容，不建 File 记录、不参与项目资料归档
 *     （与「附件必须关联项目」边界：仅文件/图片强制关联）
 *   - 返回 {voiceId, size}；读取走 GET /api/im/voice/:uuid（鉴权 + uuid 白名单）
 */

import { NextRequest } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { apiHandler, ok, ApiError, requireAuth } from '@/lib/api-helpers'
import { fileRoot } from '@/lib/file-storage'

export const dynamic = 'force-dynamic'

const MAX_VOICE_SIZE = 2 * 1024 * 1024 // 2MB（≤2MB，v4-pro 定案）
const ALLOWED_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const formData = await request.formData()
  const uploaded = formData.get('file')
  const isFileLike =
    uploaded !== null &&
    typeof uploaded === 'object' &&
    typeof (uploaded as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    typeof (uploaded as { name?: unknown }).name === 'string'
  if (!isFileLike) {
    throw ApiError.badRequest('缺少 multipart 字段 file')
  }
  const file = uploaded as File
  // 去掉 codecs 参数（如 audio/webm;codecs=opus → audio/webm）再匹配白名单
  const mime = (file.type || '').toLowerCase().split(';')[0].trim()
  const ext = ALLOWED_MIME[mime]
  if (!ext) {
    throw ApiError.badRequest(`不支持的音频格式（${mime || '未知'}），仅支持 webm/ogg/mp4/mpeg`)
  }
  if (file.size > MAX_VOICE_SIZE) {
    throw ApiError.badRequest('语音文件不能超过 2MB（超过 60 秒将自动截断）')
  }
  if (file.size === 0) {
    throw ApiError.badRequest('语音文件为空')
  }

  const duration = Number(formData.get('duration') ?? 0)
  const voiceId = randomUUID()
  const dir = path.join(fileRoot(), 'im-voice')
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${voiceId}.${ext}`)

  const buf = Buffer.from(await file.arrayBuffer())
  await fs.writeFile(target, buf)

  return ok({
    voiceId,
    size: buf.length,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
  })
})
