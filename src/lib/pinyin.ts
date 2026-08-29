// 中文姓名 → 全拼用户名（新增人员免邮箱时自动生成登录账号）
// 基于 pinyin-pro：无声调全拼，遇非中文字符原样保留
import { pinyin } from 'pinyin-pro'

export function cn2pin(name: string): string {
  if (!name) return ''
  const raw = pinyin(name.trim(), { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
  // 仅保留字母数字，转小写
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return cleaned
}
