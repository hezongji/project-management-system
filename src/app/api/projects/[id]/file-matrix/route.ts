/**
 * /api/projects/[id]/file-matrix —— 依据《开发文档-项目管理系统重构》§7.7
 *
 * GET  项目 view  ★ 文件矩阵（归档核对表：条目×状态 + 缺项）
 *
 * 响应 data：
 *   summary 全局状态计数（total/required + 各状态计数，OBSOLETED 单独列出）
 *   groups  条目×状态矩阵：按 phaseCode + catalogId 分组，每组统计
 *           WAITING/SUBMITTED/REVIEWING/APPROVED/REJECTED/NA 各状态计数（§7.7）
 *   rows    全量条目行（前端总表：名称/编号/阶段/目录/责任人/状态/版本数）
 *   missing 缺项清单：必需(required=true)且未通过（status ∉ APPROVED/NA）的条目
 *           [{ id, name, code, status, owner, catalog, dueDate }] —— 与 §7.4
 *           归档拦截同口径（归档拦截 errors[] = { name, status, owner }）
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth } from '@/lib/api-helpers'
import { requireCan } from '@/lib/permission'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const STATUSES = ['WAITING', 'SUBMITTED', 'REVIEWING', 'APPROVED', 'REJECTED', 'NA', 'OBSOLETED'] as const

/** 矩阵分组统计的六态（§7.7：APPROVED/WAITING/SUBMITTED/REVIEWING/REJECTED/NA）；键用驼峰小写与 summary 对齐 */
const MATRIX_STATUSES = ['WAITING', 'SUBMITTED', 'REVIEWING', 'APPROVED', 'REJECTED', 'NA'] as const

const zeroCounts = () => ({
  waiting: 0,
  submitted: 0,
  reviewing: 0,
  approved: 0,
  rejected: 0,
  na: 0,
})

export const GET = apiHandler<Ctx>(async (request: NextRequest, { params }) => {
  const { id } = await params
  const user = requireAuth(request)
  await requireCan(user.userId, 'view', { type: 'PROJECT', id: id })

  const [requirements, phases] = await Promise.all([
    prisma.fileRequirement.findMany({
      where: { projectId: id },
      include: {
        owner: { select: { id: true, name: true } },
        catalog: { select: { id: true, name: true } },
        _count: { select: { files: true } },
      },
      orderBy: [{ phaseCode: 'asc' }, { catalogId: 'asc' }, { name: 'asc' }],
    }),
    prisma.phase.findMany({
      where: { projectId: id },
      select: { code: true, name: true },
    }),
  ])

  const phaseNameByCode = new Map(phases.map((p) => [p.code, p.name]))

  // ── summary：全局状态计数 ──
  const summary = {
    total: requirements.length,
    required: requirements.filter((r) => r.required).length,
    ...Object.fromEntries(STATUSES.map((s) => [s.toLowerCase(), 0])),
  } as Record<string, number> & { total: number; required: number }
  for (const r of requirements) {
    summary[r.status.toLowerCase()] = (summary[r.status.toLowerCase()] ?? 0) + 1
  }

  // ── rows：前端总表全量行（每行一条目）──
  const rows = requirements.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    required: r.required,
    status: r.status,
    owner: r.owner,
    phaseCode: r.phaseCode,
    phaseName: r.phaseCode ? (phaseNameByCode.get(r.phaseCode) ?? null) : null,
    catalogId: r.catalogId,
    catalogName: r.catalog.name,
    versionCount: r._count.files,
  }))

  // ── groups：条目×状态矩阵（按 phaseCode + catalogId 分组）──
  const groupMap = new Map<
    string,
    {
      phaseCode: string | null
      phaseName: string | null
      catalogId: string
      catalogName: string
      total: number
      required: number
      counts: ReturnType<typeof zeroCounts>
    }
  >()
  for (const r of requirements) {
    const key = `${r.phaseCode ?? '∅'}::${r.catalogId}`
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        phaseCode: r.phaseCode,
        phaseName: r.phaseCode ? (phaseNameByCode.get(r.phaseCode) ?? null) : null,
        catalogId: r.catalogId,
        catalogName: r.catalog.name,
        total: 0,
        required: 0,
        counts: zeroCounts(),
      })
    }
    const g = groupMap.get(key)!
    g.total += 1
    if (r.required) g.required += 1
    if ((MATRIX_STATUSES as readonly string[]).includes(r.status)) {
      g.counts[r.status.toLowerCase() as keyof typeof g.counts] += 1
    }
  }
  const groups = Array.from(groupMap.values())

  // ── missing：缺项清单（必需 && status ∉ APPROVED/NA，§7.4 归档拦截同口径）──
  const missing = requirements
    .filter((r) => r.required && r.status !== 'APPROVED' && r.status !== 'NA')
    .map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      status: r.status,
      owner: r.owner,
      catalog: r.catalog,
      dueDate: r.dueDate,
    }))

  return ok({ summary, groups, rows, missing })
})
