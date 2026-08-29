'use client'

import { Suspense } from 'react'
import { PageGuard } from '@/components/layout/page-guard'
import { MessagesPageInner } from '@/components/im/messages-page-inner'

/**
 * /messages —— 依据《开发文档-项目管理系统重构》§8.2⑥（IM 完整化）
 * 桌面双栏版（(main) 布局内）。核心实现已抽取到共享组件 MessagesPageInner，
 * /im（独立聊天 App 壳）与其共用同一数据链路，消息天然同步。
 */
export default function MessagesPage() {
  return (
    <PageGuard pageKey="messages">
      {/* useSearchParams/useFocusHighlight 须 Suspense 包裹（Next.js 预渲染约束） */}
      <Suspense fallback={null}>
        <MessagesPageInner mode="desktop" />
      </Suspense>
    </PageGuard>
  )
}
