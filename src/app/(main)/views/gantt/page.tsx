import { Suspense } from 'react'

import { GanttView } from './gantt-view'

/**
 * /views/gantt —— GanttView（甘特图）P3 交付，依据《开发文档-项目管理系统重构》§8.2⑤
 *
 *   - gantt-task-react 双层任务：Phase 父条（project）+ Task 子条（task）
 *   - 今日线（todayColor）、依赖箭头（Phase 顺序连线 PH01→PH02→…）
 *   - 拖拽改期 → PATCH（Phase: /api/phases/:id plannedStart/plannedEnd；Task: /api/tasks/:id dueDate）
 *   - 顶部 <ProjectViewPicker />（读 ?projectId=）
 *
 * ⚠️ GanttView 内部用 useSearchParams，须用 <Suspense> 包裹（Next.js App Router 预渲染约束）。
 */
export default function GanttPage() {
  return (
    <Suspense
      fallback={<div className="h-10 animate-pulse rounded bg-muted" />}
    >
      <GanttView />
    </Suspense>
  )
}
