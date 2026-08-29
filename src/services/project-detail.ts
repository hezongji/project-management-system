/**
 * 项目详情 / 根树服务层 —— P1-3
 * 对接：/api/projects/:id（详情+PATCH）、/tree、/archive、/phases/order、/api/phases/:id、/skip
 * 归档拦截 400 时把 §7.7 格式的 errors[]（{name,status,owner}）带出供前端渲染缺项清单。
 */

import { ApiService } from './api'
import { ApiError } from './api'
import type { ProjectTreeData, ArchiveBlocker } from '@/types/project-tree'

export interface PhasePatchBody {
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'PAUSED'
  ownerId?: string | null
  plannedStart?: string | null
  plannedEnd?: string | null
}

/** 归档拦截 400 专属错误（携带 §7.7 缺项清单 errors[]） */
export class ArchiveBlockedError extends Error {
  blockers?: ArchiveBlocker[]
}

export class ProjectDetailService {
  /** GET /api/projects/:id/tree —— 根树聚合（§7.4 契约） */
  static getTree(id: string) {
    return ApiService.get<ProjectTreeData>(`/projects/${id}/tree`)
  }

  /** GET /api/projects/:id —— 详情（phase 概览/myRole/can） */
  static getDetail(id: string) {
    return ApiService.get<unknown>(`/projects/${id}`)
  }

  /** PATCH /api/projects/:id —— 基本信息维护 */
  static patchProject(
    id: string,
    body: Partial<{
      name: string
      description: string | null
      contractNo: string | null
      location: string | null
      amount: number | null
      signedAt: string | null
      plannedStart: string | null
      plannedEnd: string | null
    }>,
  ) {
    return ApiService.patch<unknown>(`/projects/${id}`, body)
  }

  /** POST /api/projects/:id/archive —— 归档（拦截时抛 ArchiveBlockedError 携带缺项清单） */
  static async archive(id: string): Promise<ReturnType<typeof ApiService.post>> {
    try {
      return await ApiService.post(`/projects/${id}/archive`, {})
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && Array.isArray(e.errors)) {
        const err = new ArchiveBlockedError(e.message)
        err.blockers = e.errors as ArchiveBlocker[]
        throw err
      }
      throw e
    }
  }

  /** PATCH /api/projects/:id/phases/order —— 拖拽排序批量 order（仅项目 OWNER/ADMIN） */
  static reorderPhases(id: string, orders: { id: string; order: number }[]) {
    return ApiService.patch<unknown>(`/projects/${id}/phases/order`, { orders })
  }

  /** PATCH /api/phases/:id —— 状态/负责人/日期（行内操作落点） */
  static patchPhase(phaseId: string, body: PhasePatchBody) {
    return ApiService.patch<{ phase: unknown; todosCreated: number; message: string }>(
      `/phases/${phaseId}`,
      body,
    )
  }

  /** POST /api/phases/:id/skip —— 跳过（skippedNote 必填） */
  static skipPhase(phaseId: string, skippedNote: string) {
    return ApiService.post<{ phase: unknown; message: string }>(`/phases/${phaseId}/skip`, {
      skippedNote,
    })
  }
}
