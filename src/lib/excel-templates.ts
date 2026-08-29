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

/** 下载采购清单导入模板（★ 2026-08-25 字段统一：标准 8 列，与 AI 工作台/订单表单一致） */
export async function downloadPurchaseTemplate() {
  await writeWorkbook(
    [
      {
        name: '采购清单',
        header: ['品名', '型号', '参数', '单位', '数量', '品牌', '单价', '备注'],
        rows: [
          ['不锈钢球阀', 'DN50', 'PN16', '个', 5, '盾安', 88.5, '首批到货'],
          ['三相异步电机', 'Y2-132M-4', '380V 7.5kW IP55', '台', 2, '西门子', 3200, ''],
        ],
      },
    ],
    '采购清单导入模板.xlsx'
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

/** 导出采购订单列表（2026-08-25：采购模块导出，浏览器端 xlsx） */
export async function exportPurchaseOrders(
  orders: Array<{
    code: string
    title: string
    projectCode: string
    projectName: string
    categoryLabel: string
    supplierName: string | null
    statusLabel: string
    amount: number | null
    itemCount: number
    arrivalCount: number
    plannedArrivalDate: string | null
    createdAt: string
    ownerName: string | null
    isSupplementary: boolean
  }>
) {
  await writeWorkbook(
    [
      {
        name: '采购订单',
        header: [
          '订单编号',
          '标题',
          '项目编号',
          '项目名称',
          '类别',
          '供应商',
          '状态',
          '金额(元)',
          '明细行数',
          '到货批次',
          '计划到货',
          '创建日期',
          '负责人',
          '追加',
        ],
        rows: orders.map((o) => [
          o.code,
          o.title,
          o.projectCode,
          o.projectName,
          o.categoryLabel,
          o.supplierName ?? '',
          o.statusLabel,
          o.amount ?? '',
          o.itemCount,
          o.arrivalCount,
          o.plannedArrivalDate ?? '',
          o.createdAt,
          o.ownerName ?? '',
          o.isSupplementary ? '是' : '',
        ]),
      },
    ],
    `采购订单-${new Date().toISOString().slice(0, 10)}.xlsx`
  )
}

/** 导出采购清单列表（2026-08-25：采购模块导出） */
export async function exportPurchaseRequests(
  reqs: Array<{
    code: string
    title: string
    projectCode: string
    projectName: string
    statusLabel: string
    priorityLabel: string
    itemCount: number
    srCount: number
    expectedArrivalDate: string | null
    requesterName: string | null
    createdAt: string
    handlerName: string | null
    rejectReason: string | null
  }>
) {
  await writeWorkbook(
    [
      {
        name: '采购清单',
        header: [
          '清单编号',
          '标题',
          '项目编号',
          '项目名称',
          '状态',
          '紧急度',
          '物料行数',
          '分解任务数',
          '期望到货',
          '提出人',
          '提交日期',
          '经办人',
          '驳回原因',
        ],
        rows: reqs.map((r) => [
          r.code,
          r.title,
          r.projectCode,
          r.projectName,
          r.statusLabel,
          r.priorityLabel,
          r.itemCount,
          r.srCount,
          r.expectedArrivalDate ?? '',
          r.requesterName ?? '',
          r.createdAt,
          r.handlerName ?? '',
          r.rejectReason ?? '',
        ]),
      },
    ],
    `采购清单-${new Date().toISOString().slice(0, 10)}.xlsx`
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

/**
 * ★ 2026-08-25 导出「项目采购总清单」（三大类合并汇总，多批次同类项已累加）
 * 单 sheet 分区：机械 → 小计 → 电气 → 小计 → 其他 → 小计 → 总计；另附批次汇总 sheet。
 * 无采购财务权限时 amount/avgUnitPrice 为 null → 导出留空。
 */
export async function exportConsolidatedPurchase(
  data: {
    project: { code: string; name: string }
    orderCount: number
    includeDraft: boolean
    categories: Array<{
      label: string
      orderCount: number
      itemCount: number
      totalQty: number
      totalAmount: number | null
      items: Array<{
        name: string
        spec: string | null
        param: string | null
        brand: string | null
        unit: string
        totalQty: number
        avgUnitPrice: number | null
        totalAmount: number | null
        batchCount: number
        orderCodes: string[]
        lastPurchasedAt: string | null
      }>
    }>
    summary: { totalAmount: number | null; totalItems: number }
  },
  generatedAtLabel: string
) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  // ── Sheet1：三大类总清单（分区 + 小计）──
  const header = [
    '序号', '名称', '型号', '参数', '品牌', '单位', '累计数量', '均价(元)', '累计金额(元)', '采购批次', '最近采购', '涉及订单',
  ]
  const rows: (string | number)[][] = []
  let grandAmount = 0
  let hasAmount = false
  for (const cat of data.categories) {
    rows.push([`【${cat.label}类】（${cat.orderCount} 张订单 · ${cat.itemCount} 种物料）`, '', '', '', '', '', '', '', '', '', '', ''])
    cat.items.forEach((it, i) => {
      rows.push([
        i + 1,
        it.name,
        it.spec ?? '',
        it.param ?? '',
        it.brand ?? '',
        it.unit,
        it.totalQty,
        it.avgUnitPrice ?? '',
        it.totalAmount ?? '',
        it.batchCount,
        it.lastPurchasedAt ? it.lastPurchasedAt.slice(0, 10) : '',
        it.orderCodes.join('、'),
      ])
    })
    if (cat.totalAmount != null) {
      hasAmount = true
      grandAmount += cat.totalAmount
    }
    rows.push([
      `${cat.label}类小计`, '', '', '', '', '',
      cat.totalQty, '', cat.totalAmount ?? '', '', '', '',
    ])
    rows.push(['', '', '', '', '', '', '', '', '', '', '', ''])
  }
  rows.push(['总计', '', '', '', '', '', '', '', hasAmount ? Math.round(grandAmount * 100) / 100 : '', '', '', ''])
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  ws['!cols'] = header.map((h, i) => ({
    wch: Math.max(h.length * 2.2 + 4, ...rows.map((r) => String(r[i] ?? '').length + 4), 10),
  }))
  XLSX.utils.book_append_sheet(wb, ws, '采购总清单')

  // ── Sheet2：批次汇总 ──
  const sumHeader = ['项目编号', '项目名称', '合并订单数', '物料种数', '总金额(元)', '含草稿', '生成时间']
  const sumRows: (string | number)[][] = [
    [
      data.project.code,
      data.project.name,
      data.orderCount,
      data.summary.totalItems,
      data.summary.totalAmount ?? '',
      data.includeDraft ? '是' : '否',
      generatedAtLabel,
    ],
    ...data.categories.map((c) => [
      `${c.label}类`,
      '',
      c.orderCount,
      c.itemCount,
      c.totalAmount ?? '',
      '',
      '',
    ]),
  ]
  const ws2 = XLSX.utils.aoa_to_sheet([sumHeader, ...sumRows])
  ws2['!cols'] = sumHeader.map((h) => ({ wch: h.length * 2.2 + 6 }))
  XLSX.utils.book_append_sheet(wb, ws2, '汇总')

  XLSX.writeFile(wb, `采购总清单-${data.project.code}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
