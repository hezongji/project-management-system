/**
 * /api/file-requirements/import —— 依据《开发文档-项目管理系统重构》§7.7 / §10.7
 *
 * POST  项目 edit  multipart/form-data：file=file-requirements.xlsx，字段 projectId、可选 dryRun=1
 *
 * 列定义（excel-import.ts / excel-templates.ts 对齐）：
 *   文件名称* 文件编号 目录* 阶段 责任人 外部提供方 用途 开放范围 截止日期 必需 备注
 *
 * 解析语义：
 *   - 「目录」按名称在该项目内精确匹配（找不到 → 该行错误，不写入）
 *   - 「责任人」「外部提供方」按名称匹配组织内用户 / 外部主体（可选，找不到报错）
 *   - 同名文件条目（同目录 + 同名称）视为已存在 → 跳过并计数（幂等，重复导入不重复建）
 *   - dryRun=1 仅校验不写库，返回 wouldCreate 与错误行
 */

import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { FileScope } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { requireCan, invalidateProject } from '@/lib/permission'
import { parseRequirementsWorkbook, normalizeScope, normalizeRequired, RowError } from '@/lib/excel-import'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)

  const form = await request.formData()
  const projectId = String(form.get('projectId') || '').trim()
  if (!projectId) throw ApiError.badRequest('缺少 projectId 字段')
  const dryRun = form.get('dryRun') === '1'

  await requireCan(user.userId, 'edit', { type: 'PROJECT', id: projectId })

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('请上传文件（表单字段名 file）')
  if (file.size === 0) throw ApiError.badRequest('上传的文件为空')
  if (file.size > 10 * 1024 * 1024) throw ApiError.badRequest('文件超过 10MB 上限')
  const fname = file.name.toLowerCase()
  if (!fname.endsWith('.xlsx') && !fname.endsWith('.xls')) {
    throw ApiError.badRequest('仅支持 .xlsx / .xls 文件')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = parseRequirementsWorkbook(buffer)
  const errors: RowError[] = [...parsed.errors]

  // 预取解析上下文：目录（名称→id）、用户（名称→id）、外部主体（名称→id）
  const [catalogs, users, orgs] = await Promise.all([
    prisma.fileCatalog.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    }),
    prisma.externalOrg.findMany({ select: { id: true, name: true } }),
  ])
  const catalogByName = new Map(catalogs.map((c) => [c.name, c.id]))
  const userByName = new Map<string, string>()
  for (const u of users) if (!userByName.has(u.name)) userByName.set(u.name, u.id)
  const orgByName = new Map<string, string>()
  for (const o of orgs) if (!orgByName.has(o.name)) orgByName.set(o.name, o.id)

  // 已存在条目（同目录+同名称）幂等去重
  const existingReqs = await prisma.fileRequirement.findMany({
    where: { projectId },
    select: { catalogId: true, name: true },
  })
  const existingKeys = new Set(existingReqs.map((r) => `${r.catalogId}|${r.name}`))

  interface ResolvedRow {
    row: number
    name: string
    code: string | null
    catalogId: string
    phaseCode: string | null
    ownerId: string | null
    externalOrgId: string | null
    purpose: string | null
    scope: FileScope
    dueDate: Date | null
    required: boolean
    remark: string | null
  }

  const resolved: ResolvedRow[] = []
  for (const r of parsed.rows) {
    const rowErrs: string[] = []
    const catalogId = catalogByName.get(r.catalogName)
    if (!catalogId) {
      rowErrs.push(`目录「${r.catalogName}」在该项目中不存在`)
    }
    let ownerId: string | null = null
    if (r.ownerName) {
      ownerId = userByName.get(r.ownerName) ?? null
      if (!ownerId) rowErrs.push(`责任人「${r.ownerName}」未找到`)
    }
    let externalOrgId: string | null = null
    if (r.externalOrgName) {
      externalOrgId = orgByName.get(r.externalOrgName) ?? null
      if (!externalOrgId) rowErrs.push(`外部提供方「${r.externalOrgName}」未找到`)
    }
    let dueDate: Date | null = null
    if (r.dueDate) {
      const d = new Date(r.dueDate)
      if (Number.isNaN(d.getTime())) rowErrs.push(`截止日期格式非法：${r.dueDate}`)
      else dueDate = d
    }

    if (rowErrs.length > 0) {
      errors.push({ row: r.row, name: r.name, reason: rowErrs.join('；') })
      continue
    }
    resolved.push({
      row: r.row,
      name: r.name,
      code: r.code || null,
      catalogId: catalogId!,
      phaseCode: r.phaseCode || null,
      ownerId,
      externalOrgId,
      purpose: r.purpose || null,
      scope: normalizeScope(r.scopeLabel) as FileScope,
      dueDate,
      required: normalizeRequired(r.requiredLabel) ?? true,
      remark: r.remark || null,
    })
  }

  // 幂等去重统计
  const newRows = resolved.filter((r) => !existingKeys.has(`${r.catalogId}|${r.name}`))
  const skippedDup = resolved.length - newRows.length

  if (dryRun) {
    return ok({
      dryRun: true,
      total: parsed.rows.length + parsed.errors.length,
      validRows: resolved.length,
      wouldCreate: newRows.length,
      skippedDuplicate: skippedDup,
      errors,
    })
  }

  let created = 0
  await prisma.$transaction(async (tx) => {
    for (const r of newRows) {
      await tx.fileRequirement.create({
        data: {
          projectId,
          catalogId: r.catalogId,
          name: r.name,
          code: r.code,
          phaseCode: r.phaseCode,
          ownerId: r.ownerId,
          externalOrgId: r.externalOrgId,
          purpose: r.purpose,
          scope: r.scope,
          dueDate: r.dueDate,
          required: r.required,
          remark: r.remark,
          status: 'WAITING',
        },
      })
      created++
    }
    if (created > 0) {
      await tx.activityLog.create({
        data: {
          projectId,
          userId: user.userId,
          action: 'file-requirement.import',
          detail: { created, skippedDuplicate: skippedDup } as Prisma.InputJsonValue,
        },
      })
    }
  })

  invalidateProject(projectId)
  return ok({
    dryRun: false,
    total: parsed.rows.length + parsed.errors.length,
    validRows: resolved.length,
    created,
    skippedDuplicate: skippedDup,
    errors,
  })
})
