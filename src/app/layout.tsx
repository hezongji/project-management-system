import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/toaster'
import { QueryProvider } from '@/components/query-provider'
import { AuthProvider } from '@/components/auth-provider'
import { SocketProvider } from '@/components/socket-provider'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: '项目管理系统',
  description: '现代化的项目管理和团队协作平台',
  manifest: '/manifest.json',
  keywords: ['项目管理', '团队协作', '任务管理', '甘特图'],
  authors: [{ name: '项目管理系统团队' }],
}

// Next 14+：viewport/themeColor 从 metadata 拆分到独立 Viewport 导出
// W2：viewportFit:'cover' 使 env(safe-area-inset-*) 生效（移动端手势条安全区适配）
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          themes={['light', 'dark', 'warm', 'mist', 'mint', 'dusk']}
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            <AuthProvider>
              <SocketProvider>
                {children}
                <Toaster />
              </SocketProvider>
            </AuthProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}