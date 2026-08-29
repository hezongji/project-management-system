'use client'

/**
 * 文件预览对话框 —— §7.7「PDF/图片内联预览」
 *
 * 打开时调 GET /api/files/:id/preview（blob → objectURL），
 * 按 mimeType 分流：application/pdf → iframe 内联；image/* → <img>。
 * objectURL 在关闭/切换文件时释放，避免内存泄漏。
 */

import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { FileService } from '@/services/file'
import type { FileVersionDto } from '@/types/phase'

interface FilePreviewDialogProps {
  file: FileVersionDto | null
  open: boolean
  onClose: () => void
}

export function FilePreviewDialog({ file, open, onClose }: FilePreviewDialogProps) {
  const { toast } = useToast()
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const urlRef = useRef<string | null>(null)

  const release = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setUrl(null)
  }

  useEffect(() => {
    if (!open || !file) return
    let cancelled = false
    setLoading(true)
    release()
    FileService.preview(file.id)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        urlRef.current = objectUrl
        setUrl(objectUrl)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
          (err as Error).message
        toast({ title: '预览失败', description: msg, variant: 'destructive' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.id])

  const isPdf = file?.mimeType?.toLowerCase() === 'application/pdf'

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[90vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="truncate text-sm font-medium" title={file?.name}>
              {file?.name ?? '预览'}
            </span>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <X className="h-4 w-4" />
                <span className="sr-only">关闭</span>
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="relative flex-1 overflow-hidden bg-muted/30">
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && url && isPdf && (
              <iframe
                src={url}
                title={file?.name ?? 'pdf-preview'}
                className="h-full w-full border-0"
              />
            )}
            {!loading && url && !isPdf && (
              <div className="flex h-full w-full items-center justify-center overflow-auto p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={file?.name ?? 'image-preview'} className="max-h-full max-w-full object-contain" />
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
