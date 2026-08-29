'use client'

/**
 * 全局确认对话框服务（2026-08-22 UIUX 评测 P0 修复）
 *
 * 替代 window.confirm（原生弹窗在 WebView/iframe 下不可靠、与 Radix 视觉割裂）。
 * 用法（调用方只需一行，无需管理状态）：
 *   if (!(await globalConfirm(`确认删除目录「${name}」？`))) return
 *   if (!(await globalConfirm('确认删除？', { destructive: true, confirmText: '删除' }))) return
 *
 * 挂载：<GlobalConfirmProvider> 包在 (main)/layout.tsx
 */

import * as React from 'react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

interface ConfirmOptions {
  title?: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
}

let resolver: ((ok: boolean) => void) | null = null
let currentOptions: { message: string; options: ConfirmOptions } | null = null
let listeners: Array<() => void> = []

function notify() {
  listeners.forEach((l) => l())
}

/** 全局确认：返回 Promise<boolean>（用户点确认 true / 取消或关闭 false） */
export function globalConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (resolver) {
    // 已有弹窗打开：先关旧的（返回 false），再开新的
    resolver(false)
    resolver = null
  }
  currentOptions = { message, options }
  notify()
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

export function GlobalConfirmProvider() {
  const [, forceUpdate] = React.useState(0)

  React.useEffect(() => {
    const l = () => forceUpdate((n) => n + 1)
    listeners.push(l)
    return () => {
      listeners = listeners.filter((x) => x !== l)
    }
  }, [])

  const close = (ok: boolean) => {
    if (resolver) {
      resolver(ok)
      resolver = null
    }
    currentOptions = null
    notify()
  }

  const open = !!currentOptions
  const { message, options } = currentOptions ?? { message: '', options: {} }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close(false)
      }}
      title={options.title ?? '确认操作'}
      description={message}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      destructive={options.destructive}
      onConfirm={() => close(true)}
    />
  )
}
