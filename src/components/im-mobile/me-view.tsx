'use client'

/**
 * 「我的」视图（v1.2 W2，微信式个人页）
 * 头像/姓名/角色 · 版本信息 · App 下载入口 · 退出登录
 */

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store/auth'
import { ImAvatar } from '@/components/im/message-bubble'
import { LogOut, Smartphone, ChevronRight } from 'lucide-react'

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理员',
  MANAGER: '项目经理',
  MEMBER: '成员',
  VIEWER: '成员',
  USER: '成员',
}

export function MeView() {
  const router = useRouter()
  const { user, logout } = useAuthStore()
  // v1.3：真实 App 版本（壳层 JS bridge；浏览器内无 bridge 提示未安装 App）
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    try {
      const v = (window as unknown as { AndroidBridge?: { getAppVersion?: () => string } }).AndroidBridge?.getAppVersion?.()
      if (v) setAppVersion(v)
    } catch {
      /* 无 bridge（浏览器）忽略 */
    }
  }, [])

  const handleLogout = () => {
    logout()
    router.replace('/login?next=%2Fim')
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="shrink-0 border-b bg-card px-4 pb-2 pt-3">
        <h1 className="text-lg font-semibold">我的</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 个人信息卡（微信式） */}
        <div className="flex items-center gap-3 border-b bg-card px-4 py-5">
          <ImAvatar name={user?.name} avatar={user?.avatar ?? null} className="h-14 w-14 text-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold">{user?.name || '成员'}</span>
              {user?.role && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                  {ROLE_LABEL[user.role] || user.role}
                </span>
              )}
            </div>
            {user?.email && <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>}
          </div>
        </div>

        {/* 操作项 */}
        <div className="mt-2 border-y bg-card">
          <button
            type="button"
            onClick={() => router.push('/download')}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm"
          >
            <Smartphone className="h-5 w-5 shrink-0 text-primary" />
            <span className="flex-1">App 下载页 / 版本</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        <div className="mt-2 border-y bg-card">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm text-destructive"
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className="flex-1">退出登录</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          PM 聊天 {appVersion ? `v${appVersion}` : '（未安装 App·浏览器模式）'} · 与 PM 系统消息实时同步
        </p>
      </div>
    </div>
  )
}
