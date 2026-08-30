'use client'

/**
 * 消息气泡 —— 依据《开发文档-项目管理系统重构》§8.2⑥ / §9.2 / §9.3
 *
 * 覆盖全类型气泡：
 *   TEXT          普通文字（自己右侧 / 他人左侧，头像 + 名字 + 时间）
 *   IMAGE         fileMeta.fileId → /files/:id/preview 缩略图，点击放大
 *   FILE          fileMeta 文件卡片（图标 + 文件名 + 大小，点击下载）
 *   SYSTEM        居中灰条系统消息
 *   TASK_CARD/PHASE_CARD/ISSUE/REPORT  卡片式气泡（委托 MessageCard）
 * 附加能力：引用原文缩略条、撤回（已撤回灰条 + 撤回按钮）、@提及高亮
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn, bytesToSize, getInitials } from '@/lib/utils'
import { FileService } from '@/services/file'
import { MessageCard } from './cards'
import { type MessageItem, type FileMeta, formatMessageTime, previewText } from './utils'
import { FileText, Image as ImageIcon, FolderOpen, Reply, Undo2, Play, Pause, Volume2 } from 'lucide-react'

export function ImAvatar({
  name,
  avatar,
  className,
}: {
  name?: string | null
  avatar?: string | null
  className?: string
}) {
  if (avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar}
        alt={name || '成员'}
        className={cn('h-9 w-9 shrink-0 rounded-full object-cover', className)}
      />
    )
  }
  return (
    <div
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary',
        className,
      )}
    >
      {getInitials(name || '?')}
    </div>
  )
}

function QuotedStrip({ quoted, mine }: { quoted: MessageItem; mine: boolean }) {
  const preview = previewText(quoted.type, quoted.content)
  const senderName = quoted.sender?.name || '成员'
  return (
    <div
      className={cn(
        'mb-1.5 rounded border-l-2 px-2 py-1 text-xs',
        mine ? 'border-primary-foreground/50 bg-black/10' : 'border-primary/50 bg-black/5',
      )}
    >
      <div className="font-medium opacity-80">{senderName}</div>
      <div className="truncate opacity-70">{preview}</div>
    </div>
  )
}

function ImageBubble({ message, onImageClick }: { message: MessageItem; onImageClick?: (m: MessageItem) => void }) {
  const meta = message.fileMeta as FileMeta | null | undefined
  const fileId = meta?.fileId
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!fileId) return
    let cancelled = false
    FileService.preview(fileId)
      .then((u) => {
        if (cancelled) return
        objectUrlRef.current = u
        setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [fileId])

  if (!fileId) {
    return (
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        <ImageIcon className="h-4 w-4" />图片（缺少文件）
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        <ImageIcon className="h-4 w-4" />图片加载失败
      </div>
    )
  }
  if (!url) {
    return (
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        <ImageIcon className="h-4 w-4" />图片加载中…
      </div>
    )
  }
  return (
    <>
      <button type="button" onClick={() => (onImageClick ? onImageClick(message) : setOpen(true))} className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={meta?.name || '图片'}
          className="max-h-48 max-w-56 cursor-zoom-in rounded object-cover"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{meta?.name || '图片预览'}</DialogTitle>
          </DialogHeader>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="预览" className="max-h-[70vh] w-full rounded object-contain" />
        </DialogContent>
      </Dialog>
    </>
  )
}

function FileBubble({ message, mine }: { message: MessageItem; mine: boolean }) {
  const meta = message.fileMeta as FileMeta | null | undefined
  const fileId = meta?.fileId
  const name = meta?.name || '文件'
  const size = meta?.size != null ? bytesToSize(meta.size) : ''
  // v1.1 W3：归档归属行（项目/目录发送时快照；老消息缺字段不显示）
  const archive = meta?.projectName ? `${meta.projectName}${meta.catalogName ? '/' + meta.catalogName : ''}` : ''
  const [downloading, setDownloading] = useState(false)

  const download = async () => {
    if (!fileId) return
    setDownloading(true)
    try {
      await FileService.download(fileId, name)
    } catch {
      /* 下载失败静默，避免打断会话流 */
    } finally {
      setDownloading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={!fileId || downloading}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left',
        mine ? 'border-primary-foreground/30' : 'border-foreground/15',
      )}
    >
      <FileText className="h-6 w-6 shrink-0 opacity-80" />
      <div className="min-w-0">
        <div className="max-w-44 truncate text-xs font-medium">{name}</div>
        <div className="text-[10px] opacity-70">
          {size}
          {downloading ? ' · 下载中…' : fileId ? ' · 点击下载' : ''}
        </div>
        {archive && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] opacity-80">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate">{archive}</span>
          </div>
        )}
      </div>
    </button>
  )
}

function VoiceBubble({ message, mine }: { message: MessageItem; mine: boolean }) {
  const meta = message.fileMeta as FileMeta | null | undefined
  const voiceId = meta?.voiceId
  const duration = Math.round(meta?.duration ?? 0)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  // fetch→blob→objectURL（Bearer 鉴权，<audio src> 直链必 401）
  const load = async () => {
    if (!voiceId || urlRef.current) return
    try {
      const { api } = await import('@/services/api')
      const response = await api.get(`/im/voice/${voiceId}`, { responseType: 'blob' })
      const blob = response.data as Blob
      urlRef.current = URL.createObjectURL(blob)
      const audio = new Audio(urlRef.current)
      audio.onended = () => setPlaying(false)
      audioRef.current = audio
      audio.play().then(() => setPlaying(true)).catch(() => {})
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const toggle = async () => {
    if (!audioRef.current) {
      await load()
      return
    }
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  if (!voiceId || error) {
    return (
      <span className="flex items-center gap-1.5 text-xs opacity-80">
        <Volume2 className="h-4 w-4" />语音{error ? '（加载失败）' : ''}
      </span>
    )
  }
  return (
    <button type="button" onClick={toggle} className="flex items-center gap-2 py-0.5">
      <span className={cn('relative flex h-6 w-6 items-center justify-center rounded-full', mine ? 'bg-black/10' : 'bg-primary/10')}>
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </span>
      <span className="text-xs">{duration > 0 ? `${duration}"` : '语音'}</span>
    </button>
  )
}

function BubbleContent({
  message,
  mine,
  projectId,
  onNavigate,
  onImageClick,
}: {
  message: MessageItem
  mine: boolean
  projectId?: string | null
  onNavigate: (path: string) => void
  onImageClick?: (m: MessageItem) => void
}) {
  switch (message.type) {
    case 'TEXT':
      return <span className="whitespace-pre-wrap break-words">{message.content}</span>
    case 'IMAGE':
      return <ImageBubble message={message} onImageClick={onImageClick} />
    case 'FILE':
      return <FileBubble message={message} mine={mine} />
    case 'VOICE':
      return <VoiceBubble message={message} mine={mine} />
    case 'TASK_CARD':
    case 'PHASE_CARD':
    case 'ISSUE':
    case 'REPORT':
      return <MessageCard type={message.type} content={message.content} projectId={projectId} onNavigate={onNavigate} mine={mine} />
    default:
      return <span className="whitespace-pre-wrap break-words">{message.content}</span>
  }
}

const CARD_TYPES = new Set(['TASK_CARD', 'PHASE_CARD', 'ISSUE', 'REPORT'])

export interface MessageBubbleProps {
  message: MessageItem
  mine: boolean
  /** 群聊里他人消息是否显示名字 */
  showName?: boolean
  /** 本地解析出的被引用消息（replyToId → 消息列表查找） */
  quoted?: MessageItem | null
  /** 该消息是否 @ 到了本人（mentions 含本人 id） */
  mentionedMe?: boolean
  /** 自己发送且 2 分钟内未撤回 → 显示撤回按钮 */
  canRevoke?: boolean
  onReply?: (m: MessageItem) => void
  onRevoke?: (m: MessageItem) => void
  projectId?: string | null
  onNavigate?: (path: string) => void
  /** 移动端微信式样式（头像/气泡/按钮常显） */
  variant?: 'desktop' | 'mobile'
  /** 移动端：双击对方头像 → 插入@（群聊） */
  onAvatarDoubleTap?: (m: MessageItem) => void
  /** 移动端：点击图片 → 外部全屏浏览（微信式） */
  onImageClick?: (m: MessageItem) => void
}

export function MessageBubble({
  message,
  mine,
  showName = false,
  quoted = null,
  mentionedMe = false,
  canRevoke = false,
  onReply,
  onRevoke,
  projectId,
  onNavigate,
  variant = 'desktop',
  onAvatarDoubleTap,
  onImageClick,
}: MessageBubbleProps) {
  const router = useRouter()
  const isMobile = variant === 'mobile'
  // 移动端双击头像检测（两次 tap <300ms）
  const lastTap = useRef(0)
  const handleAvatarTap = () => {
    if (!isMobile || !onAvatarDoubleTap) return
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      onAvatarDoubleTap(message)
    } else {
      lastTap.current = now
    }
  }
  // 卡片跳转统一追加来源标记：目标页显示「已定位 · 来自:消息卡片」（已有 src= 则不覆盖）
  const go = (path: string) => {
    const target = path.includes('src=')
      ? path
      : `${path}${path.includes('?') ? '&' : '?'}src=${encodeURIComponent('消息卡片')}`
    onNavigate ? onNavigate(target) : router.push(target)
  }

  // 系统消息：居中灰条
  if (message.type === 'SYSTEM') {
    return (
      <div className="flex justify-center py-0.5">
        <div className="max-w-[80%] rounded-full bg-muted/60 px-4 py-1 text-center text-xs text-muted-foreground">
          {message.content}
        </div>
      </div>
    )
  }

  // 已撤回：灰条，不再渲染原内容
  if (message.revoked) {
    return (
      <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
        <div className="max-w-[70%] rounded-md bg-muted/40 px-3 py-1.5 text-xs italic text-muted-foreground">
          {mine ? '你撤回了一条消息' : '对方撤回了一条消息'}
        </div>
      </div>
    )
  }

  const senderName = message.sender?.name || '成员'
  const time = formatMessageTime(message.createdAt)
  const isCard = CARD_TYPES.has(message.type)

  return (
    <div className={cn('group flex items-end gap-2', mine ? 'flex-row-reverse' : 'flex-row', isMobile && 'gap-1.5')}>
      {/* 移动端微信式：我方不显头像 */}
      {(!isMobile || !mine) && (
        <div onTouchEnd={handleAvatarTap} className={cn(isMobile && onAvatarDoubleTap && 'cursor-pointer')}>
          <ImAvatar name={senderName} avatar={message.sender?.avatar} />
        </div>
      )}
      <div className={cn('flex max-w-[70%] flex-col', isMobile && 'max-w-[75%]', mine ? 'items-end' : 'items-start')}>
        {showName && !mine && <div className="mb-0.5 px-1 text-xs text-muted-foreground">{senderName}</div>}
        <div
          className={cn(
            'rounded-lg',
            !isCard && (mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'),
            !isCard && isMobile && (mine ? 'bg-[#95ec69] text-foreground' : 'bg-white text-foreground shadow-sm'),
            !isCard && 'px-3 py-2 text-sm',
            isMobile && 'rounded-md',
            mentionedMe && 'ring-2 ring-amber-400/70',
          )}
        >
          {quoted && <QuotedStrip quoted={quoted} mine={mine} />}
          <BubbleContent message={message} mine={mine} projectId={projectId} onNavigate={go} onImageClick={onImageClick} />
        </div>
        <div
          className={cn(
            'mt-0.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground',
            mine && 'flex-row-reverse',
          )}
        >
          <span>{time}</span>
          {onReply && (
            <button
              type="button"
              onClick={() => onReply(message)}
              className={cn(
                'flex items-center gap-0.5 hover:text-primary',
                // 移动端触屏常显（修复 group-hover 触屏不可见缺陷）；桌面保持 hover 显隐
                isMobile ? 'opacity-70' : 'opacity-0 transition-opacity group-hover:opacity-100',
              )}
            >
              <Reply className="h-3 w-3" />
              回复
            </button>
          )}
          {canRevoke && onRevoke && (
            <button
              type="button"
              onClick={() => onRevoke(message)}
              className={cn(
                'flex items-center gap-0.5 hover:text-destructive',
                isMobile ? 'opacity-70' : 'opacity-0 transition-opacity group-hover:opacity-100',
              )}
            >
              <Undo2 className="h-3 w-3" />
              撤回
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
