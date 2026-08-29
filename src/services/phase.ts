/**
 * 阶段服务层 —— §7.5 / §8.2②（阶段下钻页数据源）
 */

import { ApiService } from './api'
import type {
  PhaseDetailDto,
  PhaseStatus,
  TaskStatus,
} from '@/types/phase'

export class PhaseService {
  /** GET /api/phases/:id 下钻聚合（四区契约数据源） */
  static async getPhaseDetail(phaseId: string) {
    return ApiService.get<PhaseDetailDto>(`/phases/${phaseId}`)
  }

  /** PATCH /api/phases/:id 状态（含置 DONE 前置校验，失败抛带 reason 的 ApiError） */
  static async updatePhaseStatus(phaseId: string, status: PhaseStatus) {
    return ApiService.patch<{ phase: PhaseDetailDto['phase'] }>(`/phases/${phaseId}`, {
      status,
    })
  }

  /** PATCH /api/phases/:id checklist 勾选 */
  static async toggleChecklistItem(phaseId: string, index: number, checked: boolean) {
    return ApiService.patch<{ phase: PhaseDetailDto['phase'] }>(`/phases/${phaseId}`, {
      checklistItem: { index, checked },
    })
  }

  /** PATCH /api/phases/:id 改派负责人 */
  static async updatePhaseOwner(phaseId: string, ownerId: string | null) {
    return ApiService.patch<{ phase: PhaseDetailDto['phase'] }>(`/phases/${phaseId}`, {
      ownerId,
    })
  }

  /** PATCH /api/phases/:id 计划/实际日期 */
  static async updatePhaseDates(
    phaseId: string,
    dates: {
      plannedStart?: string | null
      plannedEnd?: string | null
      actualStart?: string | null
      actualEnd?: string | null
    },
  ) {
    return ApiService.patch<{ phase: PhaseDetailDto['phase'] }>(`/phases/${phaseId}`, dates)
  }

  /** PATCH /api/tasks/:id 拖拽换列（status；§8.2② 看板） */
  static async updateTaskStatus(taskId: string, status: TaskStatus) {
    return ApiService.patch<{ task: { id: string; status: TaskStatus } }>(
      `/tasks/${taskId}`,
      { status },
    )
  }
}
