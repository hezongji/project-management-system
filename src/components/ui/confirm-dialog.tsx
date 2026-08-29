'use client'

/**
 * ConfirmDialog —— 统一确认弹窗（2026-08-22 UIUX 评测 P0 修复）
 *
 * 替代全部 window.confirm（原生弹窗在 WebView/iframe 下不可靠、视觉割裂）。
 * 用法：
 *   const [open, setOpen] = React.useState(false)
 *   ... trigger ...
 *   <ConfirmDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     title="确认删除"
 *     description="该操作不可恢复"
 *     onConfirm={async () => { await doDelete(); setOpen(false) }}
 *   />
 */

import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** true = 危险操作（红色按钮） */
  destructive?: boolean
  loading?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  destructive = false,
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const handleConfirm = async () => {
    if (loading) return
    try {
      await onConfirm()
    } finally {
      // 由调用方控制关闭（便于 await 失败时保持弹窗）
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={(e) => {
              e.preventDefault()
              handleConfirm()
            }}
            className={cn(destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
          >
            {loading && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * 便捷 hook：管理一个 ConfirmDialog 的开关 + 回调
 *   const confirm = useConfirm()
 *   confirm.ask('确认删除？', '不可恢复', async () => await del())
 *   <ConfirmDialog open={confirm.open} onOpenChange={confirm.setOpen} ... />
 */
export function useConfirm() {
  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState<{
    title: string
    description?: string
    confirmText?: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  } | null>(null)

  const ask = React.useCallback(
    (
      title: string,
      description?: string,
      onConfirm?: () => void | Promise<void>,
      opts?: { confirmText?: string; destructive?: boolean },
    ) => {
      setState({
        title,
        description,
        confirmText: opts?.confirmText,
        destructive: opts?.destructive,
        onConfirm: onConfirm ?? (() => {}),
      })
      setOpen(true)
    },
    [],
  )

  const close = React.useCallback(() => setOpen(false), [])

  return {
    open,
    setOpen,
    ask,
    close,
    render: state ? (
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={state.title}
        description={state.description}
        confirmText={state.confirmText}
        destructive={state.destructive}
        onConfirm={async () => {
          await state.onConfirm()
          setOpen(false)
        }}
      />
    ) : null,
  }
}
