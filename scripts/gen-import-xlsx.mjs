/**
 * 生成 Excel 导入验收样例（P0-4）
 *
 *   node scripts/gen-import-xlsx.mjs
 *
 * 产出（写入 prisma/data/generated/）：
 *   - users.xlsx        ：prisma/data/company-employees.json（真实 51 人）→ §10.7 导入模板格式
 *   - external-orgs.xlsx：虚构演示 5 家（含联系人）→ §10.7 导入模板格式
 *   - users-bad.xlsx    ：3 行坏数据（缺姓名/坏邮箱/坏部门路径），验收错误行报告
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as XLSX from 'xlsx'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(root, 'prisma', 'data')
const OUT = join(DATA, 'generated')
mkdirSync(OUT, { recursive: true })

function save(filename, rows, headers) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!cols'] = headers.map((h, i) => ({
    wch: Math.max(h.length * 2.2 + 4, ...rows.map((r) => String(r[i] ?? '').length + 4), 10),
  }))
  XLSX.utils.book_append_sheet(wb, ws, filename.replace('.xlsx', ''))
  XLSX.writeFile(wb, join(OUT, filename))
  console.log(`✓ ${filename}（${rows.length} 行）`)
}

// ── users.xlsx：真实 51 人 ──
const employees = JSON.parse(readFileSync(join(DATA, 'company-employees.json'), 'utf8'))
const userRows = employees.staff.map((s) => [
  s.name,
  s.email,
  s.phone || '',
  s.dept || '',
  s.jobTitle || '',
  s.duties || '',
  '', // 初始密码空 = demo123456
])
save('users.xlsx', userRows, ['姓名*', '邮箱*', '手机', '部门', '岗位', '职责', '初始密码'])

// ── external-orgs.xlsx：虚构演示 5 家 ──
const orgRows = [
  ['东岳电气元件', '供应商', '赵主管', '销售', '13800000001', 'zhao@dongyue.example.cn', '虚构演示'],
  ['宏达机柜', '供应商', '孙经理', '', '', '', '虚构演示'],
  ['精工传感器', '供应商', '周工', '技术支持', '', '', '虚构演示'],
  ['锐图钣金加工', '外协', '吴厂长', '厂长', '', '', '虚构演示'],
  ['安迅安装工程', '外包商', '郑队', '施工队长', '', '', '虚构演示'],
  // 多联系人：同主体第二行 → 追加联系人
  ['东岳电气元件', '供应商', '钱会计', '财务', '', '', ''],
]
save('external-orgs.xlsx', orgRows, ['主体名称*', '类型*', '联系人', '职务', '电话', '邮箱', '备注'])

// ── users-bad.xlsx：坏数据 3 行 ──
const badRows = [
  ['测试甲', 'ok-a@example.com', '', '技术部', '资料员', '', ''],
  ['', 'no-name@example.com', '', '', '', '', ''], // 缺姓名
  ['测试乙', 'bad-email', '', '不存在的部门', '', '', ''], // 坏邮箱 + 坏部门
]
save('users-bad.xlsx', badRows, ['姓名*', '邮箱*', '手机', '部门', '岗位', '职责', '初始密码'])

console.log('\n输出目录:', OUT)
