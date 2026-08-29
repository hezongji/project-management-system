/**
 * (auth) 登录态外布局 —— 依据《开发文档-项目管理系统重构》§2
 * login / register / forgot-password 共用（各自页面自带全屏居中样式，此处透传）
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
