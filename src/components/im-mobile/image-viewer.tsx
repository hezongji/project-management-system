'use client'

/**
 * 图片全屏浏览（v1.2 W6，微信式：黑底 + 左右滑动 + 页码 + 保存）
 * 自实现 swipe，不引第三方库。
 */

import { useEffect, useRef, useState } from 'react'
import { FileService } from '@/services/file'
import { X, Download } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ImageViewer({
  fileIds,
  index,
  onClose,
}: {
  /** 当前会话所有图片消息的 fileId（按消息顺序） */
  fileIds: string[]
  index: number
  onClose: () => void
}) {
  const [i, setI] = useState(index)
  const [url, setUrl] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  const startX = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    FileService.preview(fileIds[i])
      .then((u) => {
        if (cancelled) return
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = u
        setUrl(u)
      })
      .catch(() => !cancelled && setUrl(null))
    return () => {
      cancelled = true
    }
  }, [i, fileIds])

  const save = async () => {
    if (!url) return
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = `pm-image-${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch {
      /* 忽略 */
    }
  }

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (startX.current == null) return
    const dx = e.changedTouches[0].clientX - startX.current
    if (dx < -40 && i < fileIds.length - 1) setI(i + 1)
    if (dx > 40 && i > 0) setI(i - 1)
    startX.current = null
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-sm text-white/80">
          {i + 1} / {fileIds.length}
        </span>
        <button
          type="button"
          onClick={save}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
        >
          <Download className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-1">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="图片" className="max-h-full max-w-full select-none object-contain" draggable={false} />
        ) : (
          <span className="text-sm text-white/60">加载中…</span>
        )}
      </div>
      {/* 缩略指示点 */}
      <div className="flex shrink-0 items-center justify-center gap-1.5 pb-6" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {fileIds.map((_, di) => (
          <span key={di} className={cn('h-1 rounded-full transition-all', di === i ? 'w-4 bg-white/90' : 'w-1 bg-white/30')} />
        ))}
      </div>
    </div>
  )
}
