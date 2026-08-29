'use client'

import { useAuthStore } from '@/store/auth'
import { useEffect } from 'react'

interface AuthProviderProps {
  children: React.ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { login, logout, setLoading } = useAuthStore()

  return (
    <AuthSync login={login} logout={logout} setLoading={setLoading}>
      {children}
    </AuthSync>
  )
}

interface AuthSyncProps {
  login: (user: any) => void
  logout: () => void
  setLoading: (loading: boolean) => void
  children: React.ReactNode
}

function AuthSync({ login, logout, setLoading, children }: AuthSyncProps) {
  useEffect(() => {
    // 检查本地存储中的认证令牌
    const checkAuth = () => {
      try {
        const token = localStorage.getItem('auth-token')
        const userData = localStorage.getItem('auth-user')
        
        if (token && userData) {
          const user = JSON.parse(userData)
          login(user)
        } else {
          logout()
        }
      } catch (error) {
        console.error('认证检查失败:', error)
        logout()
      } finally {
        setLoading(false)
      }
    }

    // 初始化时检查认证状态
    setLoading(true)
    checkAuth()

    // 监听存储变化（多个标签页同步）
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'auth-token' || event.key === 'auth-user') {
        checkAuth()
      }
    }

    window.addEventListener('storage', handleStorageChange)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
    }
  }, [login, logout, setLoading])

  return <>{children}</>
}