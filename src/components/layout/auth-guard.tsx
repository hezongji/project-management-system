'use client'

/**
 * 路由守卫（P0-3）—— 依据《开发文档-项目管理系统重构》§4.7、§8.1
 *
 * (main) 布局统一挂 <AuthGuard>：
 *  - 无 token / 未认证 → 跳转 /login（router.replace，不留历史记录）
 *  - useAuthStore 沿用现有（persist，AuthProvider 负责从 localStorage 同步）
 *  - 校验完成前渲染全屏 loading，避免登录态闪跳
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth'

interface AuthGuardProps {
  children: React.ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter()
  const { isAuthenticated } = useAuthStore()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
    const authed = useAuthStore.getState().isAuthenticated
    if (!token || !authed) {
      router.replace('/login')
      return
    }
    setChecked(true)
  }, [router, isAuthenticated])

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">正在验证登录状态…</p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
