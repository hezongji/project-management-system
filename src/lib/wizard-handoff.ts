/**
 * 新建项目向导 → 项目根树占位页 的创建结果交接（sessionStorage）
 *
 * /projects/[id] 完整根树（GET /projects/:id/tree + PhaseTree）由 P1-3 交付；
 * 交接摘要仅用于创建成功后的落地页展示（阶段数/成员数/待分配提醒），
 * 无需为占位页新增 API。
 */

export const WIZARD_RESULT_KEY = 'pm:wizard-created'

export interface CreateResultSummary {
  projectId: string
  code: string
  name: string
  templateName: string
  phaseCount: number
  memberCount: number
  requirementCount: number
  pendingAssignment: { phaseCode: string; name: string; ownerJobTitle: string }[]
}

export function readWizardResult(): CreateResultSummary | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(WIZARD_RESULT_KEY)
    return raw ? (JSON.parse(raw) as CreateResultSummary) : null
  } catch {
    return null
  }
}

export function clearWizardResult() {
  if (typeof window !== 'undefined') sessionStorage.removeItem(WIZARD_RESULT_KEY)
}
