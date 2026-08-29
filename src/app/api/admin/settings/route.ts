/**
 * /api/admin/settings —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * GET    ADMIN  读取系统设置（key-value，缺失项回退默认）
 * PATCH  ADMIN  更新系统设置：{ settings: { registerEnabled?, storageQuotaPerProjectBytes? } }
 *               仅接受内置键，逐个 upsert（key 为主键），类型不符拒绝
 *
 * 注意：SystemSetting 为 §5 未定义的补充表（见 schema 注释 / lib/system-settings.ts），
 *       文档 §5 需补该表定义，请 orchestrator 回填。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, ApiError } from '@/lib/api-helpers'
import { requireAdmin } from '@/lib/admin'
import { loadSettings, DEFAULT_SETTINGS, type SettingKey } from '@/lib/system-settings'

export const dynamic = 'force-dynamic'

// ───────────────────────────── GET：读取设置 ─────────────────────────────

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)
  const settings = await loadSettings()
  return ok({ settings })
})

// ───────────────────────────── PATCH：更新设置 ─────────────────────────────

const patchSchema = z.object({
  settings: z.object({
    registerEnabled: z.boolean().optional(),
    storageQuotaPerProjectBytes: z
      .number()
      .int()
      .positive('配额必须为正整数（字节）')
      .optional(),
  }),
})

export const PATCH = apiHandler(async (request: NextRequest) => {
  await requireAdmin(request)

  const body = patchSchema.parse(await request.json())
  const incoming = body.settings
  const keys = Object.keys(incoming) as SettingKey[]

  if (keys.length === 0) {
    throw ApiError.badRequest('未提供任何设置项')
  }

  // 逐个 upsert（key 为主键，天然去重）
  await prisma.$transaction(
    keys.map((key) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: incoming[key] as boolean | number },
        update: { value: incoming[key] as boolean | number },
      })
    )
  )

  const settings = await loadSettings()
  return ok({ settings }, '系统设置已更新')
})
