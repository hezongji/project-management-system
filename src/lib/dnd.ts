'use client'

/**
 * 免打扰（DND）—— 依据《开发文档-项目管理系统重构》§7.9「待办收件箱免打扰」
 *
 * 开关存 localStorage（pm-dnd），开启后：
 *   - 静默角标（侧边栏待办角标 / 顶栏通知铃未读数不展示）
 *   - 桌面通知弹窗可据此跳过（见 notify.ts isNotifyEnabled 组合判断，可选）
 *
 * 所有 window/localStorage 访问均做 SSR 安全防护。
 */

const STORAGE_KEY = 'pm-dnd'

/** 是否开启免打扰（缺省关闭） */
export function isDndEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 设置免打扰开关（true=开 / false=关） */
export function setDndEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // ignore（隐私模式等场景 localStorage 可能抛异常）
  }
}
