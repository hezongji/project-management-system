'use client'

import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { PageGuard } from '@/components/layout/page-guard'
import { MessagesPageInner } from '@/components/im/messages-page-inner'
import { useIsMobile } from '@/hooks/use-is-mobile'

/**
 * /messages —— 依据《开发文档-项目管理系统重构》§8.2⑥（IM 完整化）
 * 桌面双栏版（(main) 布局内）。核心实现已抽取到共享组件 MessagesPageInner，
 * /im（独立聊天 App 壳）与其共用同一数据链路，消息天然同步。
 *
 * 移动端重定向 /im（sdlc:20260830-mobile-ui W1）：手机上 IM 走独立四 Tab 壳，
 * 避免桌面双栏版与移动版两套 IM 并存。
 */
export default function MessagesPage() {
  const isMobile = useIsMobile()
  const router = useRouter()

  useEffect(() => {
    if (isMobile) router.replace('/im')
  }, [isMobile, router])

  return (
    <PageGuard pageKey="messages">
      {isMobile ? (
        <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
          正在打开消息…
        </div>
      ) : (
        /* useSearchParams/useFocusHighlight 须 Suspense 包裹（Next.js 预渲染约束） */
        <Suspense fallback={null}>
          <MessagesPageInner mode="desktop" />
        </Suspense>
      )}
    </PageGuard>
  )
}
