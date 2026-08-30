'use client'

/**
 * ResponsiveDialog —— 桌面 Dialog / 移动端 Sheet 同构容器。
 * 采购等业务弹窗在移动端换底部抽屉外壳，children（DialogHeader/DialogTitle/
 * DialogFooter 及业务内容）原样复用，只换容器不换业务逻辑（spec §3.7）。
 * 桌面路径 DOM 与 shadcn Dialog 完全一致（零回归）。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Sheet } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-is-mobile'

/** 移动端关闭回调（Sheet ✕ / Dialog onOpenChange(false)） */
const MobileCloseCtx = React.createContext<() => void>(() => {})

export interface ResponsiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  /** 移动端 Sheet 最大高度（默认 92dvh，详情/长表单够用） */
  mobileMaxHeight?: string
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  children,
  mobileMaxHeight = '92dvh',
}: ResponsiveDialogProps) {
  const isMobile = useIsMobile()
  if (isMobile) {
    return (
      <MobileCloseCtx.Provider value={() => onOpenChange(false)}>
        <Sheet open={open} onClose={() => onOpenChange(false)} maxHeight={mobileMaxHeight}>
          {children}
        </Sheet>
      </MobileCloseCtx.Provider>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  )
}

export interface ResponsiveDialogContentProps
  extends React.ComponentPropsWithoutRef<'div'> {
  /** 桌面端原 DialogContent 的 className 原样应用；移动端忽略（Sheet 自带布局） */
  className?: string
  children?: React.ReactNode
}

export function ResponsiveDialogContent({
  className,
  children,
  ...props
}: ResponsiveDialogContentProps) {
  const isMobile = useIsMobile()
  const close = React.useContext(MobileCloseCtx)
  if (isMobile) {
    // 移动端：Sheet 滚动区内的内容壳 + 右上角关闭钮（补齐 Dialog 自带 ✕，触控 44px）
    return (
      <div className="relative pb-2 pr-12" data-mobile-dialog-content {...props}>
        <button
          type="button"
          aria-label="关闭"
          onClick={close}
          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
        {children}
      </div>
    )
  }
  return (
    <DialogContent className={className} {...props}>
      {children}
    </DialogContent>
  )
}
