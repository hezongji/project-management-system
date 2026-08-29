'use client'

/**
 * PageGuard —— 页面级权限拦截（权限 V2 2026-08-21）
 *
 * 用法：<PageGuard pageKey="projects">...</PageGuard>
 * 无权限时显示「无权限访问」卡片（防直接输入 URL 绕过菜单）。
 * 管理员恒可访问全部页面。
 */

import { ShieldAlert } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { Card, CardContent } from '@/components/ui/card'
import { canAccessPage } from '@/lib/page-permissions'

export function PageGuard({
  pageKey,
  children,
}: {
  pageKey: string
  children: React.ReactNode
}) {
  const user = useAuthStore((s) => s.user)

  if (!user) return null // AuthGuard 已拦截未登录
  if (user.role === 'ADMIN') return <>{children}</>

  const ok = canAccessPage(
    user.role,
    // store 中存的是最终 pages（登录时已解析）；pagePermissions 原始值不回传，
    // 直接按 pages 判定：包含该 key 即可
    user.pages ?? null,
    pageKey,
  )
  if (ok) return <>{children}</>

  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">无权限访问</h1>
        <p className="text-sm text-muted-foreground">
          你没有访问该页面的权限。如需开通，请联系管理员在「系统管理 → 权限分配」中为你分配。
        </p>
      </CardContent>
    </Card>
  )
}
