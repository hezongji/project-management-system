'use client'

/**
 * 文件上传按钮 —— §8.2④ 条目详情上传交互
 *
 * 隐藏 file input + 上传按钮；选择文件后调 FileService.submit 提交到
 * POST /api/file-requirements/:id/submit（版本递增 + sha256 + 通知 reviewer）。
 * 上传中显示进度/禁用；成功后回调 onUploaded(新版本) 供父组件刷新时间线。
 * 权限：canUpload 驱动按钮显隐（§4.7 前端不自算权限）。
 */

import { useRef, useState } from 'react'
import { UploadCloud, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { FileService } from '@/services/file'
import type { UploadedFileDto } from '@/types/file'

interface FileUploadButtonProps {
  requirementId: string
  canUpload: boolean
  onUploaded: (file: UploadedFileDto) => void
}

export function FileUploadButton({ requirementId, canUpload, onUploaded }: FileUploadButtonProps) {
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)

  if (!canUpload) return null

  const handlePick = () => {
    if (uploading) return
    inputRef.current?.click()
  }

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return

    setUploading(true)
    setProgress(0)
    try {
      const res = await FileService.submit(requirementId, file, setProgress)
      const uploaded = res.data?.file
      if (!uploaded) throw new Error('响应缺少 file 数据')
      toast({ title: '上传成功', description: `已提交第 v${uploaded.version} 版（sha256 已校验）` })
      onUploaded(uploaded)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (err as Error).message
      toast({ title: '上传失败', description: msg, variant: 'destructive' })
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleChange}
      />
      <Button
        size="sm"
        className="h-8 gap-1.5 text-xs"
        disabled={uploading}
        onClick={handlePick}
        title="上传新版本（版本递增 + sha256 校验 + 通知审核人）"
      >
        {uploading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress > 0 ? `上传中 ${progress}%` : '上传中…'}
          </>
        ) : (
          <>
            <UploadCloud className="h-3.5 w-3.5" />
            上传新版本
          </>
        )}
      </Button>
    </>
  )
}
