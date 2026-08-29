/**
 * 系统设置默认值与读取辅助 —— 依据《开发文档-项目管理系统重构》§7.10
 *
 * SystemSetting 为 §5 未定义的补充表（见 schema 注释），此处集中定义内置键、
 * 默认值口径与读取方法，供 settings/storage 接口与注册逻辑复用。
 */

import { prisma } from './prisma'

/** 每项目存储配额默认值：10GB（1 GB = 1024³ 字节） */
export const STORAGE_QUOTA_DEFAULT_BYTES = 10 * 1024 * 1024 * 1024

/** 内置设置项默认值（DB 无记录时按此口径） */
export const DEFAULT_SETTINGS = {
  registerEnabled: true,
  storageQuotaPerProjectBytes: STORAGE_QUOTA_DEFAULT_BYTES,
} as const

export type SettingKey = keyof typeof DEFAULT_SETTINGS

/** 读取全部内置设置（DB 记录覆盖默认值；缺失项回退默认） */
export async function loadSettings(): Promise<Record<SettingKey, boolean | number>> {
  const rows = await prisma.systemSetting.findMany()
  const map: Record<string, unknown> = {}
  for (const r of rows) map[r.key] = r.value

  const out = { ...DEFAULT_SETTINGS } as Record<SettingKey, boolean | number>
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    const v = map[key]
    if (v !== undefined && v !== null) {
      // 类型规整：布尔键只认布尔，数值键只认有限数字，其余回退默认
      if (key === 'registerEnabled' && typeof v === 'boolean') out[key] = v
      if (key === 'storageQuotaPerProjectBytes' && typeof v === 'number' && Number.isFinite(v)) {
        out[key] = v
      }
    }
  }
  return out
}
