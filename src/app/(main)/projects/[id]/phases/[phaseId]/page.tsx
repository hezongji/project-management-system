/**
 * 阶段下钻页（§8.2② 四区布局）
 *
 * ┌────────────────────────────────────────────┐
 * │ 头：阶段名+状态+负责人+计划/实际日期+检查项勾选区 │
 * ├──────────────────────────┬─────────────────┤
 * │ 左：任务看板四列（拖拽换列） │ 右：文件条目列表    │
 * ├──────────────────────────┴─────────────────┤
 * │ 底：该阶段动态（ActivityLog 过滤）              │
 * └────────────────────────────────────────────┘
 *
 * 数据源 GET /api/phases/:id（§7.5 下钻聚合）；
 * 状态/负责人/日期/checklist 勾选 → PATCH /api/phases/:id（阶段 edit 权限驱动显隐）。
 */
import PhaseDetailView from '@/components/phase/phase-detail-view'

/**
 * Next 16：params 为 Promise，服务端 page await 后以纯 props 传给客户端子组件。
 */
export default async function PhaseDetailPage({
  params,
}: {
  params: Promise<{ id: string; phaseId: string }>
}) {
  const { id: projectId, phaseId } = await params
  return <PhaseDetailView projectId={projectId} phaseId={phaseId} />
}
