/**
 * 视图共享取数工具 —— 分页循环拉全量（P3 评审 P1-1 修复）
 *
 * 背景：后端分页硬上限 100（src/lib/api-helpers.ts 的 parsePagination 执行
 * Math.min(100, …)），单次 GET /api/tasks 传 limit>100 会被压到 100，导致
 * GanttView / MindmapView 在单项目任务 >100 条时取数被截断。
 *
 * 本模块提供前端分页循环拉全量，不动后端契约、不改文档：
 *   - 每页 PAGE_SIZE=100（后端上限内），page 递增直到某一页不足 PAGE_SIZE
 *     （即最后一页）即停止；
 *   - 加 MAX_PAGES 防死循环保护（单项目任务量级下不可能触及）。
 */

import { ApiService } from '@/services/api'

/** 分页循环拉取某项目的全量任务（泛型 T 兼容各视图的 task DTO 子集） */
export async function fetchAllTasks<T = ViewTaskItem>(projectId: string): Promise<T[]> {
  const all: T[] = []
  const PAGE_SIZE = 100
  const MAX_PAGES = 50

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ApiService.get<{ items: T[]; pagination?: { total: number } }>(
      '/tasks',
      { projectId, page, limit: PAGE_SIZE },
    )
    const items = res.data?.items ?? []
    all.push(...items)
    // 本页不足 PAGE_SIZE → 已是最后一页，终止循环
    if (items.length < PAGE_SIZE) break
  }

  return all
}

/** 视图通用任务字段（gantt/mindmap 各自 DTO 的并集，供泛型默认使用） */
export interface ViewTaskItem {
  id: string
  title: string
  status: string
  priority?: string
  phaseId: string | null
  phase?: { id: string; code: string; name: string } | null
  assignee?: { id: string; name: string } | null
  dueDate: string | null
  startedAt: string | null
  completedAt: string | null
}
