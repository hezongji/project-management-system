/**
 * P1-5 e2e 验证链路：任务 API 全量 + 修订→回滚
 *
 * 依据《开发文档-项目管理系统重构》§7.6/§7.9，全链路走 HTTP（localhost:3000）：
 *   1. 登录 ADMIN（chenmuzhi）
 *   2. 建任务（POST /api/phases/:id/tasks，阶段 assign 权限）
 *   3. 改 assignee（PATCH /api/tasks/:id，普通更新 + TASK_ASSIGNED 通知）
 *   4. 修订：短 changeSummary → 400 校验；合法修订 → revision=2 + v1 快照 diff
 *   5. 再修订 → revision=3
 *   6. 回滚 v1 → 字段恢复 + 生成第 3 条修订记录（快照回滚前值）→ revision=4
 *   7. 筛选验证：GET /api/tasks?projectId / ?phaseId / ?mine=1
 *   8. 标注：POST annotations + PATCH resolve（本人）
 *   9. 评论：POST comments（mentions=sunruoqing）→ 通知 + 待办生成验证（查库）
 *  10. 权限抽检：MEMBER 对他人任务的越权修订 → 403
 *  11. 清理测试数据
 *
 * 运行：node scripts/e2e-p1-5.mjs
 */

import { PrismaClient } from '@prisma/client'

const BASE = process.env.E2E_BASE || 'http://localhost:3000'
const prisma = new PrismaClient()

const log = (...args) => console.log(...args)
let step = 0
const header = (name) => log(`\n━━━ [${++step}] ${name} ━━━`)

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}

function assert(cond, msg, extra) {
  if (!cond) {
    console.error(`✗ 断言失败: ${msg}`, extra ?? '')
    process.exitCode = 1
    throw new Error(msg)
  }
  log(`  ✓ ${msg}`)
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  // [1] 登录
  header('登录 ADMIN（chenmuzhi）')
  const login = await api('POST', '/auth/login', {
    body: { email: 'chenmuzhi@example.com', password: 'demo123456' },
  })
  assert(login.status === 200 && login.body?.success, '登录成功')
  const token = login.body.data.token
  const adminId = login.body.data.user.id
  log(`  token=${token.slice(0, 24)}… adminId=${adminId}`)

  const sunruoqing = await prisma.user.findUniqueOrThrow({
    where: { email: 'sunruoqing@example.com' },
    select: { id: true, name: true },
  })

  // 辅助：取种子项目 DEMO25021 的 PH06（NOT_STARTED，避免干扰联动断言）
  const project = await prisma.project.findUniqueOrThrow({
    where: { code: 'DEMO25021' },
    select: { id: true, code: true },
  })
  const phase = await prisma.phase.findUniqueOrThrow({
    where: { projectId_code: { projectId: project.id, code: 'PH06' } },
    select: { id: true, code: true, status: true },
  })
  log(`  使用种子项目 ${project.code} / ${phase.code}（${phase.status}）`)

  // [2] 阶段下建任务（阶段 assign 权限）
  header('POST /api/phases/:id/tasks 建任务')
  const created = await api('POST', `/phases/${phase.id}/tasks`, {
    token,
    body: {
      title: 'P1-5 e2e 验证任务',
      description: '验证修订→回滚链路',
      priority: 'MEDIUM',
      assigneeId: adminId,
      dueDate: '2026-12-31',
    },
  })
  assert(created.status === 201 && created.body?.success, '任务创建成功（201）')
  const taskId = created.body.data.id
  assert(created.body.data.revision === 1, `初始 revision=1`)
  assert(created.body.data.phaseId === phase.id, '任务挂在指定阶段下')
  log(`  taskId=${taskId}`)

  try {
    // [3] PATCH 改 assignee（普通更新，不生成修订）
    header('PATCH /api/tasks/:id 改 assignee → sunruoqing')
    const patched = await api('PATCH', `/tasks/${taskId}`, {
      token,
      body: { assigneeId: sunruoqing.id },
    })
    assert(patched.status === 200 && patched.body?.success, 'PATCH 成功')
    assert(patched.body.data.assigneeId === sunruoqing.id, 'assignee 已变为 sunruoqing')
    assert(patched.body.data.revision === 1, 'PATCH 普通更新不产生修订（revision 仍=1）')
    const notif = await prisma.notification.findFirst({
      where: { userId: sunruoqing.id, type: 'TASK_ASSIGNED', link: { contains: taskId } },
    })
    assert(!!notif, '已生成 TASK_ASSIGNED 通知（§5 NotifType）')

    // [4] 修订：短说明被拒
    header('POST revisions 短 changeSummary → 400')
    const shortRev = await api('POST', `/tasks/${taskId}/revisions`, {
      token,
      body: { changeSummary: '改一下', patch: { priority: 'HIGH' } },
    })
    assert(shortRev.status === 400 && /超过\s*10/.test(shortRev.body?.message ?? ''), '≤10 字说明被拒（400）')

    // [5] 修订①：priority + title（diff 验证）
    header('修订①：priority→HIGH + title 改写')
    const rev1 = await api('POST', `/tasks/${taskId}/revisions`, {
      token,
      body: {
        changeSummary: '第一次修订：客户催办提升优先级并按合同术语重写标题',
        patch: { priority: 'HIGH', title: 'P1-5 e2e 验证任务（高优先）' },
      },
    })
    assert(rev1.status === 201 && rev1.body?.success, '修订①成功（201）')
    assert(rev1.body.data.task.revision === 2, 'revision=2')
    assert(rev1.body.data.task.priority === 'HIGH', 'patch 已应用（priority=HIGH）')
    const rev1Rec = await prisma.taskRevision.findUniqueOrThrow({
      where: { taskId_version: { taskId, version: 1 } },
    })
    const snap1 = rev1Rec.snapshot
    assert(snap1.title === 'P1-5 e2e 验证任务', 'v1 快照=修订前旧值（旧标题）')
    assert(snap1.priority === 'MEDIUM', 'v1 快照=修订前旧值（MEDIUM）')
    assert(snap1.assigneeId === sunruoqing.id, 'v1 快照含 PATCH 后的 assignee（PATCH 先于修订）')

    // [6] 修订②：dueDate 清空 + status
    header('修订②：dueDate→null + status→IN_PROGRESS')
    const rev2 = await api('POST', `/tasks/${taskId}/revisions`, {
      token,
      body: {
        changeSummary: '第二次修订：取消硬性截止日并开始执行以配合阶段节奏',
        patch: { dueDate: null, status: 'IN_PROGRESS' },
      },
    })
    assert(rev2.status === 201 && rev2.body?.success, '修订②成功（201）')
    assert(rev2.body.data.task.revision === 3, 'revision=3')
    assert(rev2.body.data.task.dueDate === null, 'dueDate 已清空')

    // 阶段联动：任务开始 → PH06 NOT_STARTED→IN_PROGRESS（§7.5 规则1）
    const phaseAfter = await prisma.phase.findUniqueOrThrow({ where: { id: phase.id } })
    assert(phaseAfter.status === 'IN_PROGRESS', '阶段联动：任一子任务开始→Phase IN_PROGRESS')

    // [7] 回滚 v1
    header('回滚 v1 → 字段恢复 + 生成新修订（快照当前值）')
    const rb = await api('POST', `/tasks/${taskId}/revisions/1/rollback`, { token })
    assert(rb.status === 200 && rb.body?.success, '回滚成功（200）')
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    assert(taskAfter.title === 'P1-5 e2e 验证任务', '字段恢复：title 回到 v1')
    assert(taskAfter.priority === 'MEDIUM', '字段恢复：priority 回到 MEDIUM')
    assert(taskAfter.status === 'TODO', '字段恢复：status 回到 TODO')
    assert(taskAfter.dueDate?.toISOString().slice(0, 10) === '2026-12-31', '字段恢复：dueDate 回到 v1')
    assert(taskAfter.assigneeId === sunruoqing.id, 'assignee 未受影响（PATCH 不在修订通道）')
    assert(taskAfter.revision === 4, 'revision=4（回滚=生成新修订：1+2 次修订+1 次回滚）')
    const rbRec = await prisma.taskRevision.findUniqueOrThrow({
      where: { taskId_version: { taskId, version: 3 } },
    })
    assert(rbRec.snapshot.title === 'P1-5 e2e 验证任务（高优先）', '回滚写入的新修订快照=回滚前状态')
    assert(/回滚至版本 v1/.test(rbRec.changeSummary), '自动 changeSummary=「回滚至版本 v1…」')
    const revCount = await prisma.taskRevision.count({ where: { taskId } })
    assert(revCount === 3, '修订记录共 3 条（v1/v2/v3=回滚）')

    // 回滚后阶段联动复核：status 回 TODO，但阶段曾已开始（actualStart 已记）→ 保持 IN_PROGRESS
    const phaseFinal = await prisma.phase.findUniqueOrThrow({ where: { id: phase.id } })
    assert(phaseFinal.status === 'IN_PROGRESS' && phaseFinal.actualStart !== null, '联动复核：阶段保持 IN_PROGRESS（状态只前进）')

    // [8] 列表筛选
    header('GET /api/tasks 筛选（projectId / phaseId / mine）')
    const byPhase = await api('GET', `/tasks?phaseId=${phase.id}&limit=100`, { token })
    assert(byPhase.status === 200 && byPhase.body.data.items.some((t) => t.id === taskId), 'phaseId 筛选命中')
    const byProject = await api('GET', `/tasks?projectId=${project.id}&limit=100`, { token })
    assert(byProject.body.data.items.some((t) => t.id === taskId), 'projectId 筛选命中')
    const mineWang = await api('GET', `/tasks?mine=1&limit=100`, { token })
    assert(!mineWang.body.data.items.some((t) => t.id === taskId), 'mine=1（ADMIN）不含此任务（已改派）')
    // sunruoqing 视角：mine=1 应命中
    const loginHz = await api('POST', '/auth/login', {
      body: { email: 'sunruoqing@example.com', password: 'demo123456' },
    })
    const tokenHz = loginHz.body.data.token
    const mineHz = await api('GET', `/tasks?mine=1&limit=100`, { token: tokenHz })
    assert(mineHz.body.data.items.some((t) => t.id === taskId), 'mine=1（sunruoqing）命中此任务')

    // [9] 标注
    header('标注：POST annotations + PATCH resolve')
    const anno = await api('POST', `/tasks/${taskId}/annotations`, {
      token: tokenHz,
      body: { field: 'priority', color: 'red', note: '这个优先级需要和商务确认合同条款' },
    })
    assert(anno.status === 201, 'sunruoqing（任务 assignee=edit）可加标注')
    const annoId = anno.body.data.id
    const resolved = await api('PATCH', `/annotations/${annoId}`, {
      token: tokenHz,
      body: { resolved: true },
    })
    assert(resolved.status === 200 && resolved.body.data.resolved === true, '本人解决标注成功')
    const reopened = await api('PATCH', `/annotations/${annoId}`, {
      token,
      body: { resolved: false },
    })
    assert(reopened.status === 200 && reopened.body.data.resolved === false, 'ADMIN（任务 edit）重开标注成功')

    // [10] 评论 + mentions → 通知+待办（§7.9）
    header('评论：mentions → 通知 + 待办')
    const beforeNotif = await prisma.notification.count({
      where: { userId: sunruoqing.id, type: 'MENTION', link: { contains: taskId } },
    })
    const beforeTodo = await prisma.todoItem.count({ where: { sourceId: taskId, userId: sunruoqing.id } })
    const comment = await api('POST', `/tasks/${taskId}/comments`, {
      token,
      body: {
        content: `@孙若清 请在周会前把电气原理图的版本确认一下`,
        mentions: [sunruoqing.id],
      },
    })
    assert(comment.status === 201 && comment.body?.success, '评论发表成功')
    assert(Array.isArray(comment.body.data.mentions) && comment.body.data.mentions[0] === sunruoqing.id, 'mentions 已存档')
    const afterNotif = await prisma.notification.count({
      where: { userId: sunruoqing.id, type: 'MENTION', link: { contains: taskId } },
    })
    const afterTodo = await prisma.todoItem.count({ where: { sourceId: taskId, userId: sunruoqing.id } })
    assert(afterNotif === beforeNotif + 1, `MENTION 通知已生成（${beforeNotif}→${afterNotif}）`)
    assert(afterTodo === beforeTodo + 1, `待办已生成（${beforeTodo}→${afterTodo}）`)
    const list = await api('GET', `/tasks/${taskId}/comments`, { token })
    assert(list.status === 200 && list.body.data.items.length >= 1, 'GET comments 列表返回')

    // [11] 权限抽检：非项目成员 MEMBER 越权修订 → 403；未认证 → 401
    header('权限抽检：非项目成员越权 / 未认证')
    const outsider = await prisma.user.findFirst({
      where: {
        role: 'MEMBER',
        isActive: true,
        projectMembers: { none: { projectId: project.id } },
      },
      select: { email: true },
    })
    if (outsider) {
      const loginOut = await api('POST', '/auth/login', {
        body: { email: outsider.email, password: 'demo123456' },
      })
      if (loginOut.status === 200) {
        const forbidden = await api('POST', `/tasks/${taskId}/revisions`, {
          token: loginOut.body.data.token,
          body: { changeSummary: '这是一个足够长的修订说明文字', patch: { priority: 'LOW' } },
        })
        assert(forbidden.status === 403, `非项目成员修订他人任务 → 403（实测 ${forbidden.status}：${outsider.email}）`)
      } else {
        log(`  ⚠ 外部成员 ${outsider.email} 登录失败（可能已改密），跳过 403 抽检`)
      }
    }
    const noAuth = await api('POST', `/tasks/${taskId}/revisions`, {
      body: { changeSummary: '这是一个足够长的修订说明文字', patch: { priority: 'LOW' } },
    })
    assert(noAuth.status === 401, '未携带 token 的修订请求 → 401')

    header('✅ 全链路通过')
    log(`  任务 ${taskId}：revision=${taskAfter.revision}，修订记录 ${revCount} 条，字段已恢复至 v1`)
  } finally {
    // [12] 清理
    header('清理测试数据')
    await prisma.notification.deleteMany({ where: { link: { contains: taskId } } })
    await prisma.todoItem.deleteMany({ where: { sourceId: taskId } })
    await prisma.task.delete({ where: { id: taskId } })
    log(`  已删除任务 ${taskId}（级联修订/标注/评论）+ 通知/待办`)
    // 阶段状态复位（避免污染种子：PH06 回 NOT_STARTED / progress 0 / 清 actualStart）
    await prisma.phase.update({
      where: { id: phase.id },
      data: { status: 'NOT_STARTED', progress: 0, actualStart: null },
    })
    log('  PH06 阶段状态已复位')
  }
}

main()
  .catch((e) => {
    console.error('\n✗ e2e 失败：', e.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
