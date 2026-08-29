'use client'

/**
 * /forgot-password —— 忘记密码（短期兜底方案，P1-5）
 *
 * 原实现提交到不存在的 /auth/forgot-password（404），邮件/验证码流程尚未落地。
 * 短期兜底：不提交任何接口，改为提示「请联系管理员重置密码」，
 * 由管理员在「系统管理 → 用户管理」对目标用户执行「重置密码」。
 */

import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { KeyRound, ArrowLeft } from 'lucide-react'

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-900 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h2 className="mt-6 text-3xl font-extrabold text-gray-900 dark:text-white">忘记密码？</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            当前系统暂未开通自助找回，请联系管理员重置密码
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              <span>请联系管理员重置</span>
            </CardTitle>
            <CardDescription>
              管理员可在「系统管理 → 用户管理」中对指定用户执行「重置密码」操作。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                <strong>操作指引：</strong>请联系贵单位系统管理员（ADMIN），提供您的登录邮箱或姓名，
                管理员将为您重置登录密码。
              </p>
            </div>

            <Button asChild variant="outline" className="w-full">
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回登录
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
