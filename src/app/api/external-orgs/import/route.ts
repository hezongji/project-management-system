/**
 * /api/external-orgs/import —— 依据《开发文档-项目管理系统重构》§10.7
 *
 * POST ADMIN  multipart/form-data：file=external-orgs.xlsx，可选 dryRun=1
 *
 * 列定义（§10.7）：主体名称* 类型*(客户/供应商/外协/外包商) 联系人 职务 电话 邮箱 备注
 *
 * 语义：
 *   - (名称, 类型) 为唯一键：不存在 → 创建；已存在 → 更新备注并返回 id
 *   - 一行一名联系人：填了「联系人」姓名则追加（同名+同电话视为同一人不重复加）
 *   - 同一主体多行 → 后续行追加联系人（首行的备注生效，后续非空备注追加拼接）
 */

import { NextRequest } from 'next/server'
import { ExternalOrgType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, requireRole, ApiError } from '@/lib/api-helpers'
import { parseOrgsWorkbook, normalizeOrgType, RowError } from '@/lib/excel-import'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  requireRole(user, 'ADMIN')

  const form = await request.formData()
  const dryRun = form.get('dryRun') === '1'
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('请上传文件（表单字段名 file）')
  if (file.size === 0) throw ApiError.badRequest('上传的文件为空')
  if (file.size > 10 * 1024 * 1024) throw ApiError.badRequest('文件超过 10MB 上限')

  const name = file.name.toLowerCase()
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw ApiError.badRequest('仅支持 .xlsx / .xls 文件')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = parseOrgsWorkbook(buffer)

  const errors: Array<RowError & { name?: string }> = [...parsed.errors]

  // 校验联系人邮箱格式
  const validRows = []
  for (const r of parsed.rows) {
    if (r.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.contactEmail)) {
      errors.push({ row: r.row, name: r.name, reason: `联系人邮箱格式不正确：${r.contactEmail}` })
      continue
    }
    validRows.push(r)
  }

  // (name|type) → orgId，先查库里已有
  const existing = await prisma.externalOrg.findMany({
    select: { id: true, name: true, type: true },
  })
  const orgIdByKey = new Map(existing.map((o) => [`${o.name}|${o.type}`, o.id]))

  if (dryRun) {
    const keys = new Set(validRows.map((r) => `${r.name}|${normalizeOrgType(r.typeLabel)}`))
    let newOrgs = 0
    for (const k of Array.from(keys)) if (!orgIdByKey.has(k)) newOrgs++
    return ok({
      dryRun: true,
      total: parsed.rows.length + parsed.errors.length,
      validRows: validRows.length,
      wouldCreateOrgs: newOrgs,
      wouldUpdateOrgs: keys.size - newOrgs,
      wouldAddContacts: validRows.filter((r) => r.contactName).length,
      errors,
    })
  }

  let createdOrgs = 0
  let updatedOrgs = 0
  let addedContacts = 0
  /** 同一主体多行只计一次 created/updated（与 dryRun 统计口径一致） */
  const countedKeys = new Set<string>()

  for (const r of validRows) {
    const type = normalizeOrgType(r.typeLabel) as ExternalOrgType
    const key = `${r.name}|${type}`
    let orgId = orgIdByKey.get(key)

    if (!orgId) {
      const org = await prisma.externalOrg.create({
        data: { name: r.name, type, remark: r.remark || null },
      })
      orgId = org.id
      orgIdByKey.set(key, orgId)
      createdOrgs++
      countedKeys.add(key)
    } else {
      if (r.remark) {
        const cur = await prisma.externalOrg.findUnique({ where: { id: orgId }, select: { remark: true } })
        if (cur && !cur.remark) {
          await prisma.externalOrg.update({ where: { id: orgId }, data: { remark: r.remark } })
        }
      }
      if (!countedKeys.has(key)) {
        updatedOrgs++
        countedKeys.add(key)
      }
    }

    if (r.contactName) {
      // 同一主体内同名联系人视为同一人不重复添加（重复导入幂等）
      const dup = await prisma.externalContact.findFirst({
        where: { orgId, name: r.contactName },
        select: { id: true },
      })
      if (!dup) {
        await prisma.externalContact.create({
          data: {
            orgId,
            name: r.contactName,
            title: r.contactTitle || null,
            phone: r.contactPhone || null,
            email: r.contactEmail || null,
          },
        })
        addedContacts++
      }
    }
  }

  return ok({
    dryRun: false,
    total: parsed.rows.length + parsed.errors.length,
    createdOrgs,
    updatedOrgs,
    addedContacts,
    errors,
  })
})
