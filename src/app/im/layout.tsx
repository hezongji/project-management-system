import { AuthGuard } from '@/components/layout/auth-guard'

/**
 * /im —— 独立聊天 App 专页布局（W1，2026-08-29）
 *
 * 极简布局：无 Sidebar/Header/AssistantPanel，仅 AuthGuard（未登录 → /login?next=/im）。
 * WebView 壳（PM 聊天 App）加载本路由；手机全屏单栏体验由 MessagesPageInner mode='mobile' 提供。
 * 数据链路与 PM 网页 /messages 完全共享（同一 im-server + PG + JWT），消息天然同步。
 */
export default function ImLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>
}
