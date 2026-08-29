/**
 * Excel 模板下载 / 导出工具（浏览器端）—— 依据《开发文档-项目管理系统重构》§10.7
 *
 * 模板列定义与服务端 src/lib/excel-import.ts 严格对齐：
 *   users.xlsx         ：姓名* 邮箱* 手机 部门(路径:技术部/资料组) 岗位 职责 初始密码(空=demo123456)
 *   external-orgs.xlsx ：主体名称* 类型*(客户/供应商/外协/外包商) 联系人 职务 电话 邮箱 备注
 *
 * xlsx（SheetJS）体积较大，全部走动态 import，不进主 bundle。
 */

export const USERS_TEMPLATE_HEADERS = [
  '姓名*',
  '邮箱*',
  '手机',
  '部门',
  '岗位',
  '职责',
  '初始密码',
] as const

export const ORGS_TEMPLATE_HEADERS = [
  '主体名称*',
  '类型*',
  '联系人',
  '职务',
  '电话',
  '邮箱',
  '备注',
] as const

/** 文件条目导入/导出模板列（§7.7 POST /file-requirements/import，与 excel-import.ts 严格对齐） */
export const REQUIREMENTS_TEMPLATE_HEADERS = [
  '文件名称*',
  '文件编号',
  '目录*',
  '阶段',
  '责任人',
  '外部提供方',
  '用途',
  '截止日期',
  '开放范围',
  '必需',
  '备注',
] as const

const USERS_SAMPLE = [
  ['张三', 'zhangsan@example.com', '13800000000', '技术部/资料组', '资料员', '图纸归档', ''],
  ['李四', 'lisi@example.com', '', '电气设计部', '电气工程师', '电气图纸设计', ''],
]

const ORGS_SAMPLE = [
  ['恒澄饮品有限公司', '客户', '王经理', '采购部经理', '13900000000', 'wang@example.com', '老客户'],
  ['东岳电气元件厂', '供应商', '赵主管', '销售', '', '', ''],
]

const REQUIREMENTS_SAMPLE = [
  ['电气原理图', 'PROJ-PH05-E-001', '05-电气设计', 'PH05', '孙若清', '', '报审', '2026-10-01', '指定范围', '是', ''],
  ['元件清单', 'PROJ-PH05-E-002', '05-电气设计', 'PH05', '马承志', '东岳电气元件厂', '存档', '', '公开', '是', ''],
]

/** 采购清单导入模板列（2026-08-22：Excel 导入→自动分解+自动下单） */
export const PURCHASE_TEMPLATE_HEADERS = [
  '物料名称*',
  '规格型号',
  '数量*',
  '单位',
  '品牌',
  '类别',
  '供应商',
  '单价',
  '备注',
] as const

const PURCHASE_SAMPLE = [
  ['PLC 模块 CPU1214C', '6ES7 214-1AG40', 2, '台', '西门子', '电气', '东岳电气元件厂', 2500, '含底座'],
  ['不锈钢球阀', 'DN50/PN16', 10, '个', '', '机械', '诚峰阀门有限公司', 320, ''],
  ['接触器', '3RT2026-1BB40', 5, '只', '西门子', '电气', '东岳电气元件厂', 180, '线圈 24VDC'],
]

function sheetFromRows(header: readonly string[], rows: (string | number)[][]) {
  // 列宽：中文表头长度 * 2 + 数据余量
  const wscols = header.map((h, i) => ({
    wch: Math.max(h.length * 2.2 + 4, ...rows.map((r) => String(r[i] ?? '').length + 4), 10),
  }))
  return { rows: [header as unknown as (string | number)[], ...rows], wscols }
}

async function writeWorkbook(
  sheets: Array<{ name: string; header: readonly string[]; rows: (string | number)[][] }>,
  filename: string
) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const { rows, wscols } = sheetFromRows(s.header, s.rows)
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = wscols
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  XLSX.writeFile(wb, filename)
}

/** 下载 users.xlsx 导入模板（含两行示例） */
export async function downloadUsersTemplate() {
  await writeWorkbook(
    [{ name: '人员', header: USERS_TEMPLATE_HEADERS, rows: USERS_SAMPLE }],
    'users.xlsx'
  )
}

/** 下载 external-orgs.xlsx 导入模板（含两行示例） */
export async function downloadOrgsTemplate() {
  await writeWorkbook(
    [{ name: '外部主体', header: ORGS_TEMPLATE_HEADERS, rows: ORGS_SAMPLE }],
    'external-orgs.xlsx'
  )
}

/** 下载采购清单导入模板（2026-08-22：上传→自动分解） */
export async function downloadPurchaseTemplate() {
  await writeWorkbook(
    [{ name: '采购清单', header: PURCHASE_TEMPLATE_HEADERS, rows: PURCHASE_SAMPLE }],
    'purchase-import.xlsx'
  )
}

/** 导出人员花名册（部门树页面用） */
export async function exportUsers(
  users: Array<{
    name: string
    email: string
    phone: string | null
    deptPath: string
    jobTitle: string | null
    duties: string | null
  }>
) {
  await writeWorkbook(
    [
      {
        name: '人员',
        header: USERS_TEMPLATE_HEADERS,
        // 初始密码列不导出（导出模板同构，但密码留空 = 不重置）
        rows: users.map((u) => [u.name, u.email, u.phone ?? '', u.deptPath, u.jobTitle ?? '', u.duties ?? '', '']),
      },
    ],
    `人员花名册-${new Date().toISOString().slice(0, 10)}.xlsx`
  )
}

/** 导出外部主体清单（externals 页面用） */
export async function exportOrgs(
  orgs: Array<{
    name: string
    typeLabel: string
    contactName?: string
    contactTitle?: string
    contactPhone?: string
    contactEmail?: string
    remark: string | null
  }>
) {
  await writeWorkbook(
    [
      {
        name: '外部主体',
        header: ORGS_TEMPLATE_HEADERS,
        rows: orgs.map((o) => [
          o.name,
          o.typeLabel,
          o.contactName ?? '',
          o.contactTitle ?? '',
          o.contactPhone ?? '',
          o.contactEmail ?? '',
          o.remark ?? '',
        ]),
      },
    ],
    `外部主体-${new Date().toISOString().slice(0, 10)}.xlsx`
  )
}

// ───────────────────────────── file-requirements.xlsx ─────────────────────────────

/** 下载文件条目导入模板（含两行示例） */
export async function downloadRequirementsTemplate() {
  await writeWorkbook(
    [{ name: '文件条目', header: REQUIREMENTS_TEMPLATE_HEADERS, rows: REQUIREMENTS_SAMPLE }],
    'file-requirements.xlsx'
  )
}

/** 导出文件条目清单（files 页面「导出」按钮，导出当前筛选结果） */
export async function exportRequirements(
  requirements: Array<{
    name: string
    code: string | null
    catalogName: string
    phaseCode: string | null
    ownerName: string | null
    externalOrgName: string | null
    purpose: string | null
    scopeLabel: string
    statusLabel: string
    dueDate: string | null
    required: boolean
  }>
) {
  await writeWorkbook(
    [
      {
        name: '文件条目',
        header: [
          '文件名称',
          '文件编号',
          '目录',
          '阶段',
          '责任人',
          '外部提供方',
          '用途',
          '开放范围',
          '状态',
          '截止日期',
          '必需',
        ] as readonly string[],
        rows: requirements.map((r) => [
          r.name,
          r.code ?? '',
          r.catalogName,
          r.phaseCode ?? '',
          r.ownerName ?? '',
          r.externalOrgName ?? '',
          r.purpose ?? '',
          r.scopeLabel,
          r.statusLabel,
          r.dueDate ?? '',
          r.required ? '是' : '否',
        ]),
      },
    ],
    `文件条目-${new Date().toISOString().slice(0, 10)}.xlsx`
  )
}
