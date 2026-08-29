#!/usr/bin/env node
/**
 * demo-fill-tasks-messages.mjs —— 演示数据填充（任务协作 + 消息流 + 待办通知 + 问题闭环 + 催办 + 动态）
 *
 * 职责（只 INSERT，其余只读）：
 *   Task / TaskRevision / Annotation / Comment
 *   Message（复用已有 PROJECT_GROUP 会话；缺失时新建，会话名尾缀「（演示群）」便于幂等清理）
 *   TodoItem / Notification / UrgeRecord / ActivityLog
 *
 * 幂等策略（全部可识别特征清理后重灌）：
 *   Task/Annotation/Comment/TaskRevision → 标题前缀 '【演示】'（子表按 task 关系先删）
 *   Message        → JSON 类 content 含 "_demo":1；TEXT/SYSTEM 尾缀零宽符 \u200b
 *   Conversation   → 仅删本脚本新建的（name endsWith '（演示群）'），已有会话一律复用不删
 *   TodoItem / Notification → 标题前缀 '【演示】'
 *   UrgeRecord     → requirementName 尾缀 '（演示）'
 *   ActivityLog    → detail JSON 含 "_demo":1（raw SQL LIKE 清理）
 *
 * 枚举对照 prisma/schema.prisma：
 *   TaskStatus  = TODO | IN_PROGRESS | REVIEW | DONE | CANCELLED
 *   TaskPriority= LOW | MEDIUM | HIGH | URGENT
 *   MsgType     = TEXT | IMAGE | FILE | TASK_CARD | PHASE_CARD | SYSTEM | REPORT | ISSUE（本脚本用 6 种，IMAGE/FILE 不涉及）
 *   NotifType   = 19 个值（本脚本全覆盖，每类 ≥2 条共 40 条）
 *   TodoSrc     = MANUAL | TASK | PHASE | FILE_REQ | MESSAGE | ISSUE | REPORT | PURCHASE_*（按要求覆盖前 5 种）
 *   MemberRole  = OWNER | ADMIN | MEMBER ；ConvType = PROJECT_GROUP
 *
 * 运行：node scripts/demo-fill-tasks-messages.mjs（项目根目录，读 .env 的 DATABASE_URL）
 */

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ───────────────────── 环境（手动解析 .env，不引 dotenv）─────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* .env 可选，缺失时依赖外部环境变量 */ }
if (!process.env.DATABASE_URL) {
  console.error('✗ 缺少 DATABASE_URL（项目根 .env 或环境变量）')
  process.exit(1)
}
const prisma = new PrismaClient()

// ───────────────────── 确定性随机 ─────────────────────
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ───────────────────── 常量 / 禁用词守卫 ─────────────────────
const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const MIN = 60 * 1000
const P = '【演示】'
const ZWSP = '\u200b' // TEXT/SYSTEM 消息幂等标记（渲染不可见）
const DEMO_JSON = '"_demo":1' // JSON 类消息/动态幂等标记
const BANNED = ['YYGC', 'sunyue', 'hezongji'] // 追加任何需要防混入的内部词
function clean(s) {
  for (const w of BANNED) if (s.includes(w)) throw new Error(`禁用词 "${w}" 出现在: ${s}`)
  return s
}

// ───────────────────── 文案池（全部过 clean）─────────────────────
const TASK_VERBS = ['方案细化', '图纸评审', '参数核对', '物料确认', '进度对齐', '资料编制', '联调准备', '归档整理', '变更评估', '外协跟进', '现场核对', '交付预检'].map(clean)
const TASK_DESCS = [
  '按最新评审意见更新图纸并归档。', '与客户确认关键参数后回签。', '核对元件清单与图纸一致性。',
  '跟进外协件回厂计划，异常及时上报。', '整理本阶段交付物并提交审核。', '组织线上评审会并输出会议纪要。',
  '完成现场尺寸复核，偏差记录归档。', '更新进度计划并同步项目群。',
].map(clean)
const REV_SUMMARIES = ['按客户意见调整参数', '补充变更说明后重提', '负责人改派后更新计划', '评审意见修订', '工时与截止日调整'].map(clean)
const ANNOTATION_NOTES = ['与客户确认后更新', '此处需二次复核', '以最新版图纸为准', '注意与上阶段交付物对齐', '涉及变更，走审批流程'].map(clean)
const COMMENT_TEXTS = [
  '初稿已完成，今天下班前提交审核。', '我先预审一遍，有问题群里说。', '已按意见更新，请再看下第 3 节。',
  '这版先冻结，变更走修订流程。', '收到，明天上午给反馈。', '现场已核对完毕，与记录一致。',
].map(clean)
const TEXT_POOL = [
  '图纸评审意见已整理，今天下班前发大家。', '元件清单第三版更新了，注意核对型号。', '现场反馈安装尺寸有偏差，明天安排复核。',
  '调试计划按本周五排，有问题群里说。', '到货已清点，缺少两套配件，已联系补发。', '工艺流程图初稿完成，请相关同事评审。',
  '程序修订版已上传文件目录，注意版本号。', '明天上午九点现场例会，请准时参加。', '客户询问进度，谁这边有最新信息？',
  '线束表与图纸不一致的地方，以图纸为准。', '外协件预计后天到厂，请安排收货。', '报价单需要更新，客户要求含税口径。',
  '培训资料初版整理好了，请审阅。', '验收单模板已更新，统一使用新版。', '今晚完成配电柜接线，注意安全。',
  '明天下午客户来厂参观，保持现场整洁。', '版本冻结后不再改动，有问题提修订。', '物流单号已发到群里，注意查收。',
  '这段先按计划推进，下周例会对齐。', '联调用料今天到位，可以排测试。', '气象预警，现场作业注意防护。',
  '备件清单已提交采购，等受理。', '试验数据我这边整理，明天给出结论。', '归档资料缺两份，请责任人今天补齐。',
  '变更单已走完审批，按新方案执行。', '通讯测试通过，稳定性再观察一天。', '装箱单初稿好了，请核对数量。',
  '现场照片已传文件目录，佐证用。', '下周重点推进验收准备，请各口自查。', '售后反馈备件需求，已登记跟进。',
  '会议纪要已归档，行动项请认领。', '样件检测合格，可以小批量试制。',
].map(clean)
const ISSUE_TITLES = ['现场调试电机过载报警', '管道接口渗漏', '到货物料规格不符', '程序联调通讯超时', '包装线链板跑偏', '传感器信号漂移', '阀门响应滞后'].map(clean)
const REPORT_SUMMARIES = [
  '今日完成电气原理图绘制，元件清单编制中。', '现场安装过半，明日转入单机调试。', '采购件全部下单，跟踪到货。',
  '工艺方案评审通过，开始细化施工图。', '联调发现两处小问题，已定位待修复。', '资料归档完成 80%，明日收尾。',
].map(clean)
const REPORT_PLANS = [
  '明日完成元件清单，推进程序修订。', '明日完成主管路对接，同步压力测试。', '明日对齐物流计划，催办关键件。',
  '明日输出施工图第一版。', '明日修复后复测并记录。', '明日补齐归档并通知审核。',
].map(clean)
const SYS_TEXTS = ['项目群协作规范已更新，请查阅文件目录。', '本周期交付物清单已下发。', '项目例会改为每周一 9:30。'].map(clean)

const NOTIF_TITLES = {
  TASK_ASSIGNED: '新任务分配',
  TASK_UPDATED: '任务已更新',
  TASK_COMPLETED: '任务已完成',
  PHASE_UPDATED: '阶段状态更新',
  FILE_PENDING_REVIEW: '文件待审核',
  FILE_APPROVED: '文件已通过审核',
  FILE_DUE_SOON: '交付物即将到期',
  MENTION: '有人在消息中提到了你',
  ISSUE_NEW: '新问题上报',
  ISSUE_RESOLVED: '问题已解决',
  REPORT_NEW: '新日报待查阅',
  SYSTEM: '系统公告',
  PURCHASE_REQUEST_SUBMITTED: '新采购清单待受理',
  PURCHASE_CONTRACT_CONFIRMED: '采购合同已确认',
  PURCHASE_ORDERED: '采购已下单',
  PURCHASE_SHIPPED: '采购物料已发货',
  PURCHASE_RECEIVED: '采购物料已签收',
  PURCHASE_REJECTED: '采购到货异常',
  PURCHASE_STATUS_CHANGED: '采购状态更新',
} // 19 项；SYSTEM 复用一条补足 20 类型 ×2（见下方列表处理）
const ACTIVITY_ACTIONS = [
  { action: 'project.create', detail: { source: ['template', 'manual'] } },
  { action: 'project.update', detail: { priority: ['MEDIUM', 'HIGH'] } },
  { action: 'phase.start', detail: { status: ['NOT_STARTED', 'IN_PROGRESS'] } },
  { action: 'phase.done', detail: { status: ['IN_PROGRESS', 'DONE'] } },
  { action: 'task.create', detail: { phase: ['—', 'PH04'] } },
  { action: 'task.assign', detail: { assigneeId: ['user_a', 'user_b'] } },
  { action: 'task.complete', detail: { status: ['REVIEW', 'DONE'] } },
  { action: 'file.submit', detail: { status: ['WAITING', 'SUBMITTED'] } },
  { action: 'file.approve', detail: { status: ['REVIEWING', 'APPROVED'] } },
  { action: 'urge.create', detail: { channel: ['workbench'] } },
  { action: 'message.report', detail: { kind: ['daily'] } },
]

// ───────────────────── 时间工具（确定性）─────────────────────
/** 抓回工作时段：工作日 9:00-18:00；夜间/周末顺延，分钟偏移由 ts 哈希决定 */
function snapWorkTime(ts) {
  const d = new Date(ts)
  for (let i = 0; i < 7; i++) {
    const dow = d.getDay()
    if (dow === 0) { d.setTime(d.getTime() + 1 * DAY); continue }
    if (dow === 6) { d.setTime(d.getTime() + 2 * DAY); continue }
    const h = d.getHours()
    if (h < 9) { d.setHours(9, 10 + (hashStr(String(ts)) % 45), 0, 0); break }
    if (h >= 18) { d.setTime(d.getTime() + 1 * DAY); d.setHours(9, 10 + (hashStr(String(ts)) % 45), 0, 0); continue }
    break
  }
  return d
}
function addDays(base, n, hour = 10, minute = 0) {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  d.setHours(hour, minute, 0, 0)
  return d
}

// ───────────────────── 统计 ─────────────────────
const stats = { task: 0, revision: 0, annotation: 0, comment: 0, message: 0, conversationCreated: 0, todo: 0, notification: 0, urge: 0, activity: 0 }

// ═══════════════════════ 幂等清理 ═══════════════════════
async function cleanup() {
  // 1) 任务三子表 → 任务（TaskRevision.task 为 SetNull，必须先删；关系过滤改两步法：先查 taskId 再删）
  const demoTaskIds = (await prisma.task.findMany({ where: { title: { startsWith: P } }, select: { id: true } })).map((t) => t.id)
  const delRev = await prisma.taskRevision.deleteMany({ where: { taskId: { in: demoTaskIds } } })
  await prisma.annotation.deleteMany({ where: { taskId: { in: demoTaskIds } } })
  await prisma.comment.deleteMany({ where: { taskId: { in: demoTaskIds } } })
  const delTask = await prisma.task.deleteMany({ where: { title: { startsWith: P } } })
  // 2) 消息（JSON 标记 + 零宽标记）→ 本脚本新建的会话（连带级联成员/消息）
  const delMsg = await prisma.message.deleteMany({
    where: { OR: [{ content: { endsWith: ZWSP } }, { content: { contains: DEMO_JSON } }] },
  })
  await prisma.conversation.deleteMany({ where: { name: { endsWith: '（演示群）' } } })
  // 3) 待办 / 通知 / 催办
  const delTodo = await prisma.todoItem.deleteMany({ where: { title: { startsWith: P } } })
  const delNotif = await prisma.notification.deleteMany({ where: { title: { startsWith: P } } })
  const delUrge = await prisma.urgeRecord.deleteMany({ where: { requirementName: { endsWith: '（演示）' } } })
  // 4) 动态（Json 无 contains 过滤，走 raw SQL）
  const delAct = await prisma.$executeRaw`DELETE FROM "ActivityLog" WHERE "detail"::text LIKE ${'%' + DEMO_JSON + '%'}`
  console.log(`[cleanup] 修订${delRev.count} 任务${delTask.count} 消息${delMsg.count} 待办${delTodo.count} 通知${delNotif.count} 催办${delUrge.count} 动态${delAct}`)
}

// ═══════════════════════ 主流程 ═══════════════════════
async function main() {
  const now = new Date()
  console.log(`▶ 开始填充演示数据 @ ${now.toISOString()}`)
  await cleanup()

  // ── 目标项目：ACTIVE 未归档，取 20 个（按 code 排序，含成员）──
  const projects = await prisma.project.findMany({
    where: { status: 'ACTIVE', isArchived: false },
    orderBy: { code: 'asc' },
    take: 20,
    include: { members: { include: { user: { select: { id: true, name: true } } } } },
  })
  if (projects.length === 0) throw new Error('没有 ACTIVE 项目，请先运行 db:seed / db:seed-demo')
  // 强制包含重点测试项目 DEMO25031（用户指定页面）
  if (!projects.some((p) => p.code === 'DEMO25031')) {
    const extra = await prisma.project.findFirst({
      where: { code: 'DEMO25031' },
      include: { members: { include: { user: { select: { id: true, name: true } } } } },
    })
    if (extra) projects.push(extra)
  }
  console.log(`[scope] 目标项目 ${projects.length} 个`)

  // ═════════ 1. 任务（+ 修订/批注/评论）═════════
  const demoTaskByProject = new Map() // projectId -> Task[]
  for (const proj of projects) {
    const memberIds = proj.members.map((m) => m.userId)
    const manager = proj.members.find((m) => m.role === 'OWNER' || m.role === 'MANAGER') ?? proj.members[0]
    if (!manager) continue
    const phases = await prisma.phase.findMany({
      where: { projectId: proj.id, status: { in: ['IN_PROGRESS', 'NOT_STARTED'] } },
      orderBy: { order: 'asc' },
    })
    const rng = mulberry32(hashStr(proj.code + 'task'))
    const created = []
    let k = 0
    for (const ph of phases) {
      const n = 2 + Math.floor(rng() * 3) // 2-4
      for (let i = 0; i < n; i++, k++) {
        const r = rng()
        const status = r < 0.3 ? 'TODO' : r < 0.55 ? 'IN_PROGRESS' : r < 0.7 ? 'REVIEW' : r < 0.9 ? 'DONE' : 'CANCELLED'
        const rp = rng()
        const priority = rp < 0.35 ? 'LOW' : rp < 0.7 ? 'MEDIUM' : rp < 0.9 ? 'HIGH' : 'URGENT'
        const assigneeId = memberIds[Math.floor(rng() * memberIds.length)] ?? null
        const verb = TASK_VERBS[(hashStr(proj.code + ph.code + k) + i) % TASK_VERBS.length]
        const title = clean(`${P}${ph.name}·${verb}`)
        let startedAt = null, completedAt = null, dueDate = null
        if (status === 'TODO') dueDate = addDays(now, 3 + Math.floor(rng() * 18), 18)
        if (status === 'IN_PROGRESS') { startedAt = addDays(now, -(2 + Math.floor(rng() * 9))); dueDate = addDays(now, 1 + Math.floor(rng() * 14), 18) }
        if (status === 'REVIEW') { startedAt = addDays(now, -(5 + Math.floor(rng() * 6))); dueDate = addDays(now, Math.floor(rng() * 2), 18) }
        if (status === 'DONE') { startedAt = addDays(now, -(8 + Math.floor(rng() * 12))); completedAt = addDays(startedAt, 1 + Math.floor(rng() * 4), 17); dueDate = completedAt }
        const t = await prisma.task.create({
          data: {
            phaseId: ph.id, projectId: proj.id,
            title, description: clean(TASK_DESCS[k % TASK_DESCS.length]),
            status, priority, assigneeId, creatorId: manager.userId,
            dueDate, startedAt, completedAt, revision: 1,
          },
        })
        created.push(t)
        stats.task++
        // 修订（REVIEW/DONE 的 ~35%）
        if ((status === 'REVIEW' || status === 'DONE') && rng() < 0.35) {
          await prisma.taskRevision.create({
            data: {
              taskId: t.id, version: 2,
              changeSummary: clean(REV_SUMMARIES[k % REV_SUMMARIES.length]),
              changedById: manager.userId,
              snapshot: { title: t.title, status: 'TODO', assigneeId, priority, revision: 1 },
            },
          })
          stats.revision++
        }
        // 批注 ~20%
        if (rng() < 0.2) {
          await prisma.annotation.create({
            data: {
              taskId: t.id, userId: memberIds[Math.floor(rng() * memberIds.length)],
              field: rng() < 0.4 ? 'description' : null,
              color: ['yellow', 'red', 'blue', 'green'][Math.floor(rng() * 4)],
              note: clean(ANNOTATION_NOTES[k % ANNOTATION_NOTES.length]),
              resolved: rng() < 0.3,
            },
          })
          stats.annotation++
        }
        // 评论 ~25%（含 @mentions）
        if (rng() < 0.25) {
          const cn = 1 + Math.floor(rng() * 2)
          for (let c = 0; c < cn; c++) {
            const mentioned = memberIds[Math.floor(rng() * memberIds.length)]
            const nameOf = (uid) => proj.members.find((m) => m.userId === uid)?.user.name ?? ''
            const withMention = rng() < 0.5 && mentioned
            await prisma.comment.create({
              data: {
                taskId: t.id,
                userId: memberIds[Math.floor(rng() * memberIds.length)],
                content: clean(withMention ? `@${nameOf(mentioned)} ${COMMENT_TEXTS[(k + c) % COMMENT_TEXTS.length]}` : COMMENT_TEXTS[(k + c) % COMMENT_TEXTS.length]),
                mentions: withMention ? [mentioned] : undefined,
              },
            })
            stats.comment++
          }
        }
      }
    }
    demoTaskByProject.set(proj.id, created)
  }
  console.log(`[tasks] 新增 ${stats.task}（修订${stats.revision} 批注${stats.annotation} 评论${stats.comment}）`)

  // ═════════ 2. 消息流（15 个项目群 × 20-40 条）═════════
  const msgProjects = projects.slice(0, 15)
  const convInfoByProject = new Map() // projectId -> { convId, memberIds, lastTs }
  for (const proj of msgProjects) {
    const memberIds = proj.members.map((m) => m.userId)
    const manager = proj.members.find((m) => m.role === 'OWNER' || m.role === 'MANAGER') ?? proj.members[0]
    if (!manager || memberIds.length === 0) continue
    let conv = await prisma.conversation.findFirst({ where: { projectId: proj.id, type: 'PROJECT_GROUP' } })
    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          type: 'PROJECT_GROUP',
          name: clean(`${proj.code} ${proj.name.slice(0, 6)}协作群（演示群）`),
          projectId: proj.id, createdBy: manager.userId,
        },
      })
      for (const m of proj.members) {
        await prisma.conversationMember.create({
          data: { conversationId: conv.id, userId: m.userId, role: m.userId === manager.userId ? 'OWNER' : 'MEMBER' },
        })
      }
      stats.conversationCreated++
    }
    const rng = mulberry32(hashStr(proj.code + 'msg'))
    const count = 20 + Math.floor(rng() * 21) // 20-40
    const startMs = now.getTime() - 14 * DAY
    const step = (13.5 * DAY) / count
    const demoTasks = demoTaskByProject.get(proj.id) ?? []
    const phases = await prisma.phase.findMany({ where: { projectId: proj.id }, orderBy: { order: 'asc' }, select: { id: true, code: true, name: true } })
    const nameOf = (uid) => proj.members.find((m) => m.userId === uid)?.user.name ?? ''

    const rows = []
    let prevTs = 0
    for (let i = 0; i < count; i++) {
      let ts = snapWorkTime(startMs + i * step).getTime()
      if (ts <= prevTs) ts = prevTs + (17 + (hashStr(String(ts)) % 40)) * MIN
      prevTs = ts
      const r = rng()
      const senderId = memberIds[Math.floor(rng() * memberIds.length)]
      if (r < 0.62) { // TEXT（~1/6 带 @）
        const target = memberIds[Math.floor(rng() * memberIds.length)]
        const withMention = rng() < 0.17 && target
        const body = TEXT_POOL[(hashStr(proj.code) + i) % TEXT_POOL.length]
        rows.push({
          conversationId: conv.id, senderId, type: 'TEXT',
          content: clean((withMention ? `@${nameOf(target)} ` : '') + body + ZWSP),
          mentions: withMention ? [target] : undefined,
          createdAt: new Date(ts),
        })
      } else if (r < 0.72 && demoTasks.length) { // TASK_CARD
        const t = demoTasks[Math.floor(rng() * demoTasks.length)]
        rows.push({
          conversationId: conv.id, senderId, type: 'TASK_CARD',
          content: JSON.stringify({ taskId: t.id, taskTitle: t.title, _demo: 1 }),
          createdAt: new Date(ts),
        })
      } else if (r < 0.8 && phases.length) { // PHASE_CARD
        const ph = phases[Math.floor(rng() * phases.length)]
        rows.push({
          conversationId: conv.id, senderId, type: 'PHASE_CARD',
          content: JSON.stringify({ phaseId: ph.id, phaseCode: ph.code, phaseName: ph.name, _demo: 1 }),
          createdAt: new Date(ts),
        })
      } else if (r < 0.86) { // SYSTEM
        rows.push({
          conversationId: conv.id, senderId: manager.userId, type: 'SYSTEM',
          content: clean(SYS_TEXTS[i % SYS_TEXTS.length] + ZWSP),
          createdAt: new Date(ts),
        })
      } else if (r < 0.93) { // REPORT 日报
        const d = new Date(ts)
        rows.push({
          conversationId: conv.id, senderId, type: 'REPORT',
          content: JSON.stringify({
            kind: 'daily',
            date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
            summary: clean(REPORT_SUMMARIES[i % REPORT_SUMMARIES.length]),
            nextPlan: clean(REPORT_PLANS[i % REPORT_PLANS.length]),
            _demo: 1,
          }),
          createdAt: new Date(ts),
        })
      } else { // ISSUE
        rows.push({
          conversationId: conv.id, senderId, type: 'ISSUE',
          content: JSON.stringify({
            title: clean(ISSUE_TITLES[i % ISSUE_TITLES.length]),
            severity: ['low', 'medium', 'high'][Math.floor(rng() * 3)],
            status: 'open',
            description: clean('现场反馈，需责任人当天确认并闭环。'),
            _demo: 1,
          }),
          createdAt: new Date(ts),
        })
      }
    }
    await prisma.message.createMany({ data: rows })
    stats.message += rows.length
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(prevTs) } })
    convInfoByProject.set(proj.id, { convId: conv.id, memberIds, lastTs: prevTs })
  }
  console.log(`[messages] 新增 ${stats.message} 条（新建会话 ${stats.conversationCreated} 个）`)

  // ═════════ 3. 问题闭环 ×5（ISSUE → 任务 DONE → 跟进消息 + 通知）═════════
  let closed = 0
  for (const proj of msgProjects) {
    if (closed >= 5) break
    const info = convInfoByProject.get(proj.id)
    if (!info) continue
    const rng = mulberry32(hashStr(proj.code + 'closure'))
    const reporter = info.memberIds[Math.floor(rng() * info.memberIds.length)]
    const owner = info.memberIds[Math.floor(rng() * info.memberIds.length)]
    const title = ISSUE_TITLES[closed % ISSUE_TITLES.length]
    const t0 = now.getTime() - (6 - closed) * DAY
    const t1 = t0 + 1 * DAY
    const t2 = t0 + 1.6 * DAY
    // ISSUE 上报
    await prisma.message.create({
      data: {
        conversationId: info.convId, senderId: reporter, type: 'ISSUE',
        content: JSON.stringify({ title: clean(title), severity: 'high', status: 'open', description: clean('现场发现，需当天响应。'), _demo: 1 }),
        createdAt: snapWorkTime(t0),
      },
    })
    stats.message++
    // 关联任务（创建即 DONE，闭环动作发生在过去）
    const ph = await prisma.phase.findFirst({ where: { projectId: proj.id, status: 'IN_PROGRESS' } })
      ?? await prisma.phase.findFirst({ where: { projectId: proj.id } })
    const task = await prisma.task.create({
      data: {
        phaseId: ph?.id ?? null, projectId: proj.id,
        title: clean(`${P}问题闭环·${title}`),
        description: clean('问题上报后创建，处理完成并已闭环。'),
        status: 'DONE', priority: 'HIGH', assigneeId: owner, creatorId: reporter,
        startedAt: snapWorkTime(t0), completedAt: snapWorkTime(t1), dueDate: snapWorkTime(t1), revision: 1,
      },
    })
    stats.task++
    // 跟进消息（ISSUE 已解决）
    await prisma.message.create({
      data: {
        conversationId: info.convId, senderId: owner, type: 'TEXT',
        content: clean(`问题已解决：${title}。处理任务已完成，现场复测正常。${ZWSP}`),
        mentions: [reporter], createdAt: snapWorkTime(t2),
      },
    })
    stats.message++
    await prisma.notification.create({
      data: {
        userId: reporter, type: 'ISSUE_RESOLVED',
        title: clean(`${P}问题已解决`), body: clean(`${title} 已闭环，请知悉。`),
        link: `/messages?conversation=${info.convId}`, isRead: false,
        createdAt: snapWorkTime(t2),
      },
    })
    stats.notification++
    await prisma.conversation.update({ where: { id: info.convId }, data: { lastMessageAt: snapWorkTime(t2) } })
    closed++
  }
  console.log(`[closure] 问题闭环 ${closed} 例`)

  // ═════════ 4. TodoItem ×30（覆盖 MANUAL/TASK/PHASE/FILE_REQ/MESSAGE）═════════
  const users = await prisma.user.findMany({
    where: { isActive: true, role: { not: 'ADMIN' } },
    orderBy: { username: 'asc' }, take: 12, select: { id: true, name: true },
  })
  const allDemoTasks = [...demoTaskByProject.values()].flat()
  const somePhases = await prisma.phase.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ['IN_PROGRESS', 'NOT_STARTED'] } },
    take: 40, select: { id: true, projectId: true },
  })
  const reqs = await prisma.fileRequirement.findMany({
    where: { projectId: { in: projects.map((p) => p.id) } },
    take: 40, select: { id: true, projectId: true },
  })
  const demoMsg = await prisma.message.findMany({
    where: { content: { endsWith: ZWSP } }, orderBy: { createdAt: 'desc' }, take: 30,
    select: { id: true, conversationId: true },
  })
  const SRC = ['MANUAL', 'TASK', 'PHASE', 'FILE_REQ', 'MESSAGE']
  const todoRows = []
  for (let i = 0; i < 30; i++) {
    const u = users[i % users.length]
    const src = SRC[i % SRC.length]
    const rng = mulberry32(hashStr('todo' + i))
    let sourceId = null, link = null
    if (src === 'TASK' && allDemoTasks.length) {
      const t = allDemoTasks[i % allDemoTasks.length]
      sourceId = t.id; link = '/tasks'
    } else if (src === 'PHASE' && somePhases.length) {
      const ph = somePhases[i % somePhases.length]
      sourceId = ph.id; link = `/projects/${ph.projectId}/phases/${ph.id}`
    } else if (src === 'FILE_REQ' && reqs.length) {
      const rq = reqs[i % reqs.length]
      sourceId = rq.id; link = `/projects/${rq.projectId}/files`
    } else if (src === 'MESSAGE' && demoMsg.length) {
      const m = demoMsg[i % demoMsg.length]
      sourceId = m.id; link = `/messages?conversation=${m.conversationId}`
    }
    const r = i % 10
    const dueAt = r < 2 ? new Date(now.getTime() - (1 + i % 3) * DAY)
      : r < 5 ? new Date(now.getTime() + (2 + i) * HOUR)
      : addDays(now, 1 + (i % 14), 18)
    const createdAt = new Date(now.getTime() - (3 + (i % 8)) * DAY)
    const doneAt = i % 3 === 0 ? new Date(createdAt.getTime() + 2 * HOUR) : null
    todoRows.push({
      userId: u.id,
      title: clean(`${P}${['核对图纸版本', '跟进外协回厂', '提交评审资料', '整理会议纪要', '更新进度计划', '盘点现场物料'][i % 6]}（${u.name}）`),
      sourceType: src, sourceId, link, dueAt, doneAt,
      priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'][i % 4],
      createdAt,
    })
  }
  if (todoRows.length) { await prisma.todoItem.createMany({ data: todoRows }); stats.todo += todoRows.length }
  console.log(`[todos] 新增 ${stats.todo} 条`)

  // ═════════ 5. Notification ×40（NotifType 全覆盖 ×2）═════════
  // 19 类 ×2 + 追加 2 条 = 40 条（每类至少 2 次）
  const TYPES = [...Object.keys(NOTIF_TITLES), 'SYSTEM', 'ISSUE_NEW']
  const notifRows = []
  for (let i = 0; i < 40; i++) {
    const type = TYPES[i % TYPES.length]
    const u = users[(i * 3) % users.length]
    const rng = mulberry32(hashStr('notif' + type + i))
    let link = null
    if (type.startsWith('TASK')) link = '/tasks'
    else if (type.startsWith('PHASE') && somePhases.length) { const ph = somePhases[i % somePhases.length]; link = `/projects/${ph.projectId}/phases/${ph.id}` }
    else if (type.startsWith('FILE') && reqs.length) { const rq = reqs[i % reqs.length]; link = `/projects/${rq.projectId}/files` }
    else if (type === 'MENTION' && demoMsg.length) { const m = demoMsg[i % demoMsg.length]; link = `/messages?conversation=${m.conversationId}` }
    else if (type.startsWith('PURCHASE')) link = '/purchase'
    else if (type.startsWith('ISSUE') || type.startsWith('REPORT')) { const info = convInfoByProject.get(msgProjects[i % msgProjects.length]?.id); if (info) link = `/messages?conversation=${info.convId}` }
    notifRows.push({
      userId: u.id, type,
      title: clean(`${P}${NOTIF_TITLES[type]}${i >= 19 ? '（二）' : ''}`),
      body: clean(['请及时处理。', '详情请点击查看。', '相关责任人已同步。'][Math.floor(rng() * 3)]),
      link, isRead: i % 3 !== 0, // 2/3 已读
      createdAt: new Date(now.getTime() - (i % 12) * DAY - (i % 5) * HOUR),
    })
  }
  await prisma.notification.createMany({ data: notifRows })
  stats.notification += notifRows.length
  console.log(`[notifications] 新增 ${stats.notification} 条（类型覆盖 ${new Set(notifRows.map((n) => n.type)).size}）`)

  // ═════════ 6. UrgeRecord ×15 ════════
  const urgeReqs = await prisma.fileRequirement.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, ownerId: { not: null } },
    include: { project: { select: { code: true } } },
    take: 60,
  })
  const urgeRows = []
  const urgeRng = mulberry32(hashStr('urge'))
  for (let i = 0; i < 15 && urgeReqs.length; i++) {
    const rq = urgeReqs[(i * 3 + 1) % urgeReqs.length]
    const proj = projects.find((p) => p.id === rq.projectId)
    const manager = proj?.members.find((m) => m.role === 'OWNER' || m.role === 'MANAGER') ?? proj?.members[0]
    if (!manager || !rq.ownerId) continue
    const isDone = urgeRng() < 0.4
    const createdAt = new Date(now.getTime() - (2 + i) * DAY)
    urgeRows.push({
      projectId: rq.projectId, projectCode: rq.project.code,
      requirementId: rq.id, requirementName: clean(`${rq.name}（演示）`),
      urgedById: manager.userId, targetUserId: rq.ownerId,
      status: isDone ? 'DONE' : 'ACTIVE',
      doneAt: isDone ? new Date(createdAt.getTime() + 1 * DAY) : null,
      createdAt,
    })
  }
  if (urgeRows.length) { await prisma.urgeRecord.createMany({ data: urgeRows }); stats.urge += urgeRows.length }
  console.log(`[urges] 新增 ${stats.urge} 条`)

  // ═════════ 7. ActivityLog（10 项目 × 8-15 条）═════════
  for (const proj of projects.slice(0, 10)) {
    const memberIds = proj.members.map((m) => m.userId)
    if (!memberIds.length) continue
    const rng = mulberry32(hashStr(proj.code + 'act'))
    const n = 8 + Math.floor(rng() * 8) // 8-15
    const rows = []
    for (let i = 0; i < n; i++) {
      const tpl = ACTIVITY_ACTIONS[(hashStr(proj.code) + i) % ACTIVITY_ACTIONS.length]
      rows.push({
        projectId: proj.id,
        userId: memberIds[Math.floor(rng() * memberIds.length)],
        action: tpl.action,
        detail: { ...tpl.detail, _demo: 1 },
        createdAt: snapWorkTime(now.getTime() - (13 - Math.floor((i / n) * 13)) * DAY - Math.floor(rng() * 8) * HOUR),
      })
    }
    await prisma.activityLog.createMany({ data: rows })
    stats.activity += rows.length
  }
  console.log(`[activities] 新增 ${stats.activity} 条`)

  // ═════════ 8. 覆盖性验收（查库复核）═════════
  const [taskStatuses, taskPriorities, notifTypes, todoSrcs, msgTypes] = await Promise.all([
    prisma.task.findMany({ where: { title: { startsWith: P } }, select: { status: true }, distinct: ['status'] }),
    prisma.task.findMany({ where: { title: { startsWith: P } }, select: { priority: true }, distinct: ['priority'] }),
    prisma.notification.findMany({ where: { title: { startsWith: P } }, select: { type: true }, distinct: ['type'] }),
    prisma.todoItem.findMany({ where: { title: { startsWith: P } }, select: { sourceType: true }, distinct: ['sourceType'] }),
    prisma.message.findMany({ where: { OR: [{ content: { endsWith: ZWSP } }, { content: { contains: DEMO_JSON } }] }, select: { type: true }, distinct: ['type'] }),
  ])
  const st = taskStatuses.map((x) => x.status).sort()
  const pr = taskPriorities.map((x) => x.priority).sort()
  const nt = notifTypes.map((x) => x.type).sort()
  const ts = todoSrcs.map((x) => x.sourceType).sort()
  const mt = msgTypes.map((x) => x.type).sort()
  console.log('\n══════════ 覆盖性验收 ══════════')
  console.log(`TaskStatus   实际=${st.join(',')}（期望含 CANCELLED,DONE,IN_PROGRESS,REVIEW,TODO）`)
  console.log(`TaskPriority 实际=${pr.join(',')}（期望含 HIGH,LOW,MEDIUM,URGENT）`)
  console.log(`NotifType    实际 ${nt.length}/19 类`)
  console.log(`TodoSrc      实际=${ts.join(',')}（期望含 FILE_REQ,MANUAL,MESSAGE,PHASE,TASK）`)
  console.log(`MsgType      实际=${mt.join(',')}（期望含 ISSUE,PHASE_CARD,REPORT,SYSTEM,TASK_CARD,TEXT）`)
  const ok =
    ['CANCELLED', 'DONE', 'IN_PROGRESS', 'REVIEW', 'TODO'].every((v) => st.includes(v)) &&
    ['HIGH', 'LOW', 'MEDIUM', 'URGENT'].every((v) => pr.includes(v)) &&
    nt.length >= 19 &&
    ['FILE_REQ', 'MANUAL', 'MESSAGE', 'PHASE', 'TASK'].every((v) => ts.includes(v)) &&
    ['ISSUE', 'PHASE_CARD', 'REPORT', 'SYSTEM', 'TASK_CARD', 'TEXT'].every((v) => mt.includes(v))
  console.log(ok ? '✓ 覆盖性验收通过' : '✗ 覆盖性验收未通过（请检查）')

  console.log('\n══════════ 填充汇总 ══════════')
  console.log(JSON.stringify(stats, null, 2))
  console.log(`完成 @ ${new Date().toISOString()}`)
}

main()
  .catch((e) => { console.error('✗ 演示数据填充失败:', e); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect() })
