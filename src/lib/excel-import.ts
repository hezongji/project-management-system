/**
 * Excel 导入解析与校验（服务端）—— 依据《开发文档-项目管理系统重构》§10.7
 *
 * 两套模板列定义：
 *   users.xlsx         ：姓名* 邮箱* 手机 部门(路径:技术部/资料组) 岗位 职责 初始密码(空=demo123456)
 *   external-orgs.xlsx ：主体名称* 类型*(客户/供应商/外协/外包商) 联系人 职务 电话 邮箱 备注
 *
 * 读取约定：
 *   - 取第一个工作表；首行为表头，按表头名（含 * 号容错）定位列，列顺序不敏感
 *   - 单元格一律转字符串 trim；Excel 日期/数字串自动清洗（科学计数法手机号还原）
 */

import * as XLSX from 'xlsx'

// ───────────────────────────── 行模型 ─────────────────────────────

export interface UserImportRow {
  row: number // Excel 行号（1-based，含表头行）
  name: string
  email: string
  phone: string
  deptPath: string
  jobTitle: string
  duties: string
  password: string // 空串 = 未填
}

export interface OrgImportRow {
  row: number
  name: string
  typeLabel: string
  contactName: string
  contactTitle: string
  contactPhone: string
  contactEmail: string
  remark: string
}

export interface RowError {
  row: number
  name: string
  reason: string
}

// ───────────────────────────── 底层解析 ─────────────────────────────

/** 单元格安全转字符串（数字科学计数法还原，日期转 ISO 日期部分） */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') {
    // 手机号等长数字被 Excel 存为 number 时可能丢精度/变科学计数法，尽量还原为整数串
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
    return String(v)
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim()
}

/** 表头名归一化：去空白、去 * 号 */
function normalizeHeader(h: string): string {
  return h.replace(/[\s*]/g, '')
}

interface ParsedSheet {
  /** 归一化表头 → 列下标 */
  headerIndex: Map<string, number>
  rows: unknown[][]
}

function parseSheet(buffer: Buffer): ParsedSheet {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('Excel 文件中没有工作表')
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
  })
  if (rows.length < 1) throw new Error('Excel 文件为空（缺少表头行）')
  const headerRow = (rows[0] ?? []).map((c) => normalizeHeader(cellToString(c)))
  const headerIndex = new Map<string, number>()
  headerRow.forEach((h, i) => {
    if (h && !headerIndex.has(h)) headerIndex.set(h, i)
  })
  return { headerIndex, rows: rows.slice(1) }
}

/** 取一行中某列（表头名 + 位置兜底），返回字符串 */
function pick(row: unknown[], sheet: ParsedSheet, header: string, fallbackIndex?: number): string {
  const idx = sheet.headerIndex.get(header) ?? fallbackIndex
  if (idx === undefined || idx < 0 || idx >= row.length) return ''
  return cellToString(row[idx])
}

// ───────────────────────────── users.xlsx ─────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ParsedUserFile {
  rows: UserImportRow[]
  errors: RowError[]
}

export function parseUsersWorkbook(buffer: Buffer): ParsedUserFile {
  const sheet = parseSheet(buffer)
  const rows: UserImportRow[] = []
  const errors: RowError[] = []
  const seenEmail = new Set<string>()

  sheet.rows.forEach((r, i) => {
    const rowNo = i + 2 // 1-based Excel 行号，+2 跳过表头
    const name = pick(r, sheet, '姓名', 0)
    const email = pick(r, sheet, '邮箱', 1).toLowerCase()
    if (!name && !email) return // 整行为空跳过

    if (!name) {
      errors.push({ row: rowNo, name, reason: '姓名为空（必填列）' })
      return
    }
    if (!email) {
      errors.push({ row: rowNo, name, reason: '邮箱为空（必填列）' })
      return
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ row: rowNo, name, reason: `邮箱格式不正确：${email}` })
      return
    }
    if (seenEmail.has(email)) {
      errors.push({ row: rowNo, name, reason: `邮箱在表格内重复：${email}` })
      return
    }
    seenEmail.add(email)

    rows.push({
      row: rowNo,
      name,
      email,
      phone: pick(r, sheet, '手机', 2),
      deptPath: pick(r, sheet, '部门', 3),
      jobTitle: pick(r, sheet, '岗位', 4),
      duties: pick(r, sheet, '职责', 5),
      password: pick(r, sheet, '初始密码', 6),
    })
  })

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('表格中没有数据行')
  }
  return { rows, errors }
}

// ───────────────────────────── external-orgs.xlsx ─────────────────────────────

/** 中文类型 → ExternalOrgType（§10.7），映射不区分大小写/前后缀「商」 */
export const ORG_TYPE_LABELS: Record<string, string> = {
  CUSTOMER: '客户',
  SUPPLIER: '供应商',
  OUTSOURCER: '外协',
  CONTRACTOR: '外包商',
  OTHER: '其他',
}

const TYPE_ALIASES: Record<string, string> = {
  客户: 'CUSTOMER',
  供应商: 'SUPPLIER',
  供货商: 'SUPPLIER',
  外协: 'OUTSOURCER',
  外协厂: 'OUTSOURCER',
  外包商: 'CONTRACTOR',
  外包: 'CONTRACTOR',
  其他: 'OTHER',
  customer: 'CUSTOMER',
  supplier: 'SUPPLIER',
  outsourcer: 'OUTSOURCER',
  contractor: 'CONTRACTOR',
  other: 'OTHER',
}

export function normalizeOrgType(label: string): string | null {
  const key = label.trim().toLowerCase()
  return TYPE_ALIASES[key] ?? null
}

export interface ParsedOrgFile {
  rows: OrgImportRow[]
  errors: RowError[]
}

export function parseOrgsWorkbook(buffer: Buffer): ParsedOrgFile {
  const sheet = parseSheet(buffer)
  const rows: OrgImportRow[] = []
  const errors: RowError[] = []
  /**
   * 同一主体多行 = 追加联系人（§10.7 语义：一行一联系人）。
   * key = name|type，行号升序天然保持。
   */
  const seenKeys = new Set<string>()

  sheet.rows.forEach((r, i) => {
    const rowNo = i + 2
    const name = pick(r, sheet, '主体名称', 0)
    const typeLabel = pick(r, sheet, '类型', 1)
    if (!name && !typeLabel) return

    if (!name) {
      errors.push({ row: rowNo, name, reason: '主体名称为空（必填列）' })
      return
    }
    if (!typeLabel) {
      errors.push({ row: rowNo, name, reason: '类型为空（必填列，可选：客户/供应商/外协/外包商）' })
      return
    }
    const type = normalizeOrgType(typeLabel)
    if (!type) {
      errors.push({
        row: rowNo,
        name,
        reason: `无法识别的类型「${typeLabel}」（可选：客户/供应商/外协/外包商）`,
      })
      return
    }

    const key = `${name}|${type}`
    seenKeys.add(key)
    rows.push({
      row: rowNo,
      name,
      typeLabel,
      contactName: pick(r, sheet, '联系人', 2),
      contactTitle: pick(r, sheet, '职务', 3),
      contactPhone: pick(r, sheet, '电话', 4),
      contactEmail: pick(r, sheet, '邮箱', 5),
      remark: pick(r, sheet, '备注', 6),
    })
  })

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('表格中没有数据行')
  }
  return { rows, errors }
}

// ───────────────────────────── file-requirements.xlsx ─────────────────────────────

/**
 * 文件条目导入列（§7.7 POST /file-requirements/import 复用本骨架；列定义见 excel-templates.ts）：
 *   文件名称* 文件编号 目录* 阶段 责任人 外部提供方 用途 开放范围 截止日期 必需 备注
 * 目录/责任人/外部提供方为「名称」列，由导入路由按项目上下文解析为 id。
 */
export interface RequirementImportRow {
  row: number
  name: string
  code: string
  catalogName: string
  phaseCode: string
  ownerName: string
  externalOrgName: string
  purpose: string
  scopeLabel: string
  dueDate: string
  requiredLabel: string
  remark: string
}

/** 开放范围中文标签 → FileScope（§5 FileScope 三态） */
export const SCOPE_LABELS: Record<string, string> = {
  PUBLIC: '公开',
  RESTRICTED: '指定范围',
  PRIVATE: '仅责任人',
}

const SCOPE_ALIASES: Record<string, string> = {
  公开: 'PUBLIC',
  项目公开: 'PUBLIC',
  指定范围: 'RESTRICTED',
  限定范围: 'RESTRICTED',
  仅责任人: 'PRIVATE',
  仅责任人及负责人: 'PRIVATE',
  public: 'PUBLIC',
  restricted: 'RESTRICTED',
  private: 'PRIVATE',
}

export function normalizeScope(label: string): string | null {
  const key = label.trim().toLowerCase()
  if (!key) return 'PUBLIC'
  return SCOPE_ALIASES[key] ?? null
}

/** 必需 是/否 → boolean；空 = 是（默认必需，§5 required default true） */
export function normalizeRequired(label: string): boolean | null {
  const key = label.trim().toLowerCase()
  if (!key) return true
  if (['是', 'y', 'yes', 'true', '1', '必需', '必填'].includes(key)) return true
  if (['否', 'n', 'no', 'false', '0', '非必需', '选填'].includes(key)) return false
  return null
}

export interface ParsedRequirementFile {
  rows: RequirementImportRow[]
  errors: RowError[]
}

export function parseRequirementsWorkbook(buffer: Buffer): ParsedRequirementFile {
  const sheet = parseSheet(buffer)
  const rows: RequirementImportRow[] = []
  const errors: RowError[] = []

  sheet.rows.forEach((r, i) => {
    const rowNo = i + 2
    const name = pick(r, sheet, '文件名称', 0)
    const catalogName = pick(r, sheet, '目录', 2)
    if (!name && !catalogName) return

    if (!name) {
      errors.push({ row: rowNo, name: '', reason: '文件名称为空（必填列）' })
      return
    }
    if (!catalogName) {
      errors.push({ row: rowNo, name, reason: '目录为空（必填列，需与项目内目录名一致）' })
      return
    }

    const scopeLabel = pick(r, sheet, '开放范围', 8)
    const scope = normalizeScope(scopeLabel)
    if (scope === null) {
      errors.push({
        row: rowNo,
        name,
        reason: `无法识别的开放范围「${scopeLabel}」（可选：公开/指定范围/仅责任人）`,
      })
      return
    }

    const requiredLabel = pick(r, sheet, '必需', 9)
    const required = normalizeRequired(requiredLabel)
    if (required === null) {
      errors.push({
        row: rowNo,
        name,
        reason: `无法识别的「必需」值「${requiredLabel}」（可选：是/否）`,
      })
      return
    }

    rows.push({
      row: rowNo,
      name,
      code: pick(r, sheet, '文件编号', 1),
      catalogName,
      phaseCode: pick(r, sheet, '阶段', 3),
      ownerName: pick(r, sheet, '责任人', 4),
      externalOrgName: pick(r, sheet, '外部提供方', 5),
      purpose: pick(r, sheet, '用途', 6),
      scopeLabel,
      dueDate: pick(r, sheet, '截止日期', 7),
      requiredLabel,
      remark: pick(r, sheet, '备注', 10),
    })
  })

  if (rows.length === 0 && errors.length === 0) {
    throw new Error('表格中没有数据行')
  }
  return { rows, errors }
}

// ───────────────────────────── 默认密码 ─────────────────────────────

export const IMPORT_DEFAULT_PASSWORD = 'demo123456'
