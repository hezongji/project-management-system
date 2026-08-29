import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'

/**
 * 任务独立详情路由已废弃（P2-1）。
 *
 * 任务详情由 task-drawer（基本信息/修订历史/标注/评论，§8.2③）承载，
 * 该抽屉从看板/任务列表内点开，无需独立页面。本路由一律 307 重定向到
 * 所属项目详情页，避免「占位页」残留误导用户。
 *
 * 跨页定位增强（2026-08-24）：
 *   入口若带 ?src=<来源>（消息卡片/通知等），重定向时透传 focus=taskId
 *   与 src，并优先落点到任务所属阶段的下钻页（?focus 会被任务看板消费：
 *   滚动到该任务卡并闪烁高亮 + 显示来源徽标），避免「跳转后找不到条目」。
 */

interface PageProps {
  params: Promise<{ id: string; taskId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function TaskDetailRedirectPage({
  params,
  searchParams,
}: PageProps) {
  const { id, taskId } = await params
  const sp = (await (searchParams ?? Promise.resolve({}))) as Record<string, string | string[] | undefined>

  const src = typeof sp.src === 'string' && sp.src ? sp.src : null
  const qs = new URLSearchParams({ focus: taskId })
  if (src) qs.set('src', src)

  const task = await prisma.task
    .findUnique({ where: { id: taskId }, select: { phaseId: true } })
    .catch(() => null)

  redirect(
    task?.phaseId
      ? `/projects/${id}/phases/${task.phaseId}?${qs}`
      : `/projects/${id}?${qs}`
  )
}
