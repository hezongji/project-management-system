'use client'

import * as React from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/store/auth'
import { AuthService } from '@/services'
import { validateEmail } from '@/lib/utils'
import Link from 'next/link'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

const loginSchema = z.object({
  email: z.string().min(1, '请输入登录账号（姓名拼音）'),
  password: z.string().min(1, '请输入密码'),
})

type LoginFormData = z.infer<typeof loginSchema>

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false)
  const router = useRouter()
  const { toast } = useToast()
  const { login } = useAuthStore()

  // 记住我（2026-08-22 UIUX P1 修复）：记住账号名到 localStorage，避免每次重输
  // 注意：SSR 无 localStorage，必须防御式读取（typeof window 检查）
  const [rememberMe, setRememberMe] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  // 挂载后读取记住的账号（client-only）
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = localStorage.getItem('pm-remember-account')
      if (saved === '1') {
        setRememberMe(true)
        const email = localStorage.getItem('pm-remember-email')
        if (email) setValue('email', email)
      }
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [setValue])

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true)
    try {
      if (rememberMe) {
        localStorage.setItem('pm-remember-account', '1')
        localStorage.setItem('pm-remember-email', data.email)
      } else {
        localStorage.removeItem('pm-remember-account')
        localStorage.removeItem('pm-remember-email')
      }
      const response = await AuthService.login(data.email, data.password)
      
      if (response.success && response.data) {
        localStorage.setItem('auth-token', response.data.token)
        login(response.data.user)
        
        toast({
          title: '登录成功',
          description: `欢迎回来，${response.data.user.name}！`,
        })
        
        // 登录后自动进入全屏（类桌面应用体验）；被浏览器拒绝时静默降级
        try {
          if (typeof document !== 'undefined' && !document.fullscreenElement) {
            await document.documentElement.requestFullscreen()
          }
        } catch {
          /* 忽略全屏失败，不影响登录 */
        }
        
        router.push('/')
      } else {
        toast({
          title: '登录失败',
          description: response.message || '请检查您的账号和密码',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: '登录失败',
        description: '网络错误，请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          {/* 公司 Logo */}
          <img
            src="/logo.png"
            alt="示例智能装备有限公司"
            className="mx-auto h-20 w-20 object-contain"
          />
          <h2 className="mt-3 text-2xl font-extrabold text-gray-900 dark:text-white">
            示例智能装备有限公司
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            项目管理系统
          </p>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            或者{' '}
            <Link
              href="/register"
              className="font-medium text-primary hover:text-primary/80"
            >
              创建新账户
            </Link>
          </p>
        </div>
        
        <Card>
          <CardHeader>
            <CardTitle>登录</CardTitle>
            <CardDescription>
              输入姓名拼音和密码登录（如：chenmuzhi / 123456）
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                // 防原生 GET 提交（UIUX P1 修复：账号密码误入 URL 查询串）
                e.preventDefault()
                handleSubmit(onSubmit)(e)
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="email">登录账号（姓名拼音）</Label>
                <Input
                  id="email"
                  type="text"
                  placeholder="如：chenmuzhi"
                  autoComplete="username"
                  {...register('email')}
                  className={errors.email ? 'border-red-500' : ''}
                />
                {errors.email && (
                  <p className="text-sm text-red-500">{errors.email.message}</p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    {...register('password')}
                    className={errors.password ? 'border-red-500' : ''}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4 text-gray-400" />
                    ) : (
                      <Eye className="h-4 w-4 text-gray-400" />
                    )}
                  </button>
                </div>
                {errors.password && (
                  <p className="text-sm text-red-500">{errors.password.message}</p>
                )}
              </div>
              
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <input
                    id="remember-me"
                    name="remember-me"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded"
                  />
                  <label htmlFor="remember-me" className="ml-2 block text-sm text-gray-900 dark:text-gray-300">
                    记住我
                  </label>
                </div>
                
                <div className="text-sm">
                  <Link
                    href="/forgot-password"
                    className="font-medium text-primary hover:text-primary/80"
                  >
                    忘记密码？
                  </Link>
                </div>
              </div>
              
              <Button
                type="submit"
                className="w-full"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    登录中...
                  </>
                ) : (
                  '登录'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
        
        <div className="text-center">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            还没有账户？{' '}
            <Link
              href="/register"
              className="font-medium text-primary hover:text-primary/80"
            >
              立即注册
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}