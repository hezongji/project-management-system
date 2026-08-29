// POST /api/ai/meeting-minutes — 会话生成会议纪要（MiMo 归纳 → 落库 + 待办 + 通知）
// 设计：docs/设计方案-AI智能助手.md §七
// 流程：校验会话成员 → 拉最近 200 条消息 → MiMo 归纳 → 事务落库：
//   项目会话：项目下「会议纪要」目录 + FileRequirement 条目 + actionItems→TodoItem + 通知
//   非项目会话（SINGLE/GROUP 无 projectId）：只建 TodoItem（纪要仅会话维度，title 附 conversationId）
// 权限：requireAuth + ConversationMember 存在性校验（非成员 403）
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { apiHandler, ok, fail, requireAuth, ApiError } from '@/lib/api-helpers'
import { prisma } from '@/lib/prisma'
import { chatCompletion } from '@/lib/ai/mimo'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'
import { assertAiConfigured, extractJsonObject, miMoToApiError } from '@/lib/ai/api-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const BodySchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
})

const MAX_MESSAGES = 200
const MAX_ACTION_ITEMS = 20
const MINUTES_CATALOG_NAME = '会议纪要'

interface NormalizedActionItem {
  content: string
  assigneeName: string | null
  due: string | null
}

interface MinutesResult {
  title: string
  summary: string
  decisions: string[]
  actionItems: NormalizedActionItem[]
}

/** 归一化 MiMo 输出：类型纠偏 + 长度截断 + 脏数据丢弃，任何形态缺失兜底为可落库结构 */
function normalizeMinutes(raw: Record<string, unknown> | null): MinutesResult {
  const src = raw ?? {}
  const title =
    typeof src.title === 'string' && src.title.trim() ? src.title.trim().slice(0, 60) : '会议纪要'
  const summary = typeof src.summary === 'string' ? src.summary.trim().slice(0, 300) : ''
  const decisions = Array.isArray(src.decisions)
    ? src.decisions
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .slice(0, 10)
        .map((d) => d.trim().slice(0, 200))
    : []
  const actionItems: NormalizedActionItem[] = []
  if (Array.isArray(src.actionItems)) {
    for (const it of src.actionItems) {
      if (actionItems.length >= MAX_ACTION_ITEMS) break
      if (typeof it !== 'object' || it === null) continue
      const o = it as Record<string, unknown>
      const content = typeof o.content === 'string' ? o.content.trim().slice(0, 200) : ''
      if (!content) continue
      const assigneeName =
        typeof o.assigneeName === 'string' && o.assigneeName.trim() ? o.assigneeName.trim() : null
      const due =
        typeof o.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.due.trim()) ? o.due.trim() : null
      actionItems.push({ content, assigneeName, due })
    }
  }
  return { title, summary, decisions, actionItems }
}

function buildPrompt(
  conversationLabel: string,
  participantNames: string[],
  messageLines: string[],
): string {
  return [
    '你是项目管理系统的会议纪要助手。根据以下项目群聊/会话记录，归纳一份会议纪要。',
    `会话：${conversationLabel}`,
    `参与人：${participantNames.join('、') || '（无）'}`,
    '',
    '消息记录（时间 升序）：',
    ...messageLines,
    '',
    '输出规则：',
    '1. 严格输出单个 JSON 对象，不要解释、不要 Markdown 代码块',
    '2. 结构：{"title":"...","summary":"...","decisions":["..."],"actionItems":[{"content":"...","assigneeName":"...","due":"YYYY-MM-DD"}]}',
    '3. title：本次会议主题，≤30 字（如「河南三期项目周例会」），没有明确主题就用会话主要讨论内容概括',
    '4. summary：≤300 字，概括讨论的议题、进展与关键信息，客观、不编造',
    '5. decisions：已达成的结论/决定/共识，每条一句话；没有则空数组',
    '6. actionItems：待办事项，content 是要做什么（≤50 字），assigneeName 从消息中提到的人名或 @ 的人推断（必须是参与人列表里的名字，推断不出则填空字符串），due 仅当消息中明确提到日期/时限时填 YYYY-MM-DD，否则空字符串',
    '7. 全程用简体中文；消息太少或无实质内容时，各字段给空值（title 除外）',
  ].join('\n')
}

/** 消息渲染成 prompt 行：[MM-DD HH:mm] 发言人: 内容；非文本消息给占位（卡片/汇报等） */
function renderMessage(
  msg: { createdAt: Date; type: string; content: string },
  senderName: string,
  mentionNames: string[],
): string {
  const t = msg.createdAt
  const ts = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  let body = msg.content
  if (msg.type !== 'TEXT') {
    // CARD/REPORT/ISSUE 等结构消息：截断原文，保留可读线索
    body = `[${msg.type}消息] ${body}`
  }
  if (body.length > 500) body = body.slice(0, 500) + '…'
  const mentionSuffix = mentionNames.length > 0 ? `（@${mentionNames.join('@')}）` : ''
  return `[${ts}] ${senderName}: ${body}${mentionSuffix}`
}

export const POST = apiHandler(async (request: NextRequest) => {
  const user = requireAuth(request)
  const rl = checkAiRateLimit(user.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()

  const body = BodySchema.parse(await request.json())
  const { conversationId } = body

  // ── 1. 会话存在 + 当前用户是成员（非成员 403）──
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, type: true, name: true, projectId: true },
  })
  if (!conversation) throw new ApiError(404, '会话不存在', 'CONV_NOT_FOUND')

  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.userId } },
    select: { id: true },
  })
  if (!membership) throw new ApiError(403, '你不是该会话的成员，无法生成纪要', 'NOT_CONV_MEMBER')

  // ── 2. 拉消息（最近 200 条，含发送人姓名；@提及解析成人名线索）──
  const rawMessages = await prisma.message.findMany({
    where: { conversationId, revoked: false },
    orderBy: { createdAt: 'desc' },
    take: MAX_MESSAGES,
    select: {
      createdAt: true,
      type: true,
      content: true,
      sender: { select: { id: true, name: true } },
      mentions: true,
    },
  })
  rawMessages.reverse() // 时间升序

  if (rawMessages.length < 2) {
    throw new ApiError(400, '会话消息太少（少于 2 条），无法生成纪要', 'TOO_FEW_MESSAGES')
  }

  const participants = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { user: { select: { id: true, name: true } } },
  })
  const idToName = new Map<string, string>()
  for (const p of participants) idToName.set(p.user.id, p.user.name)

  const messageLines = rawMessages.map((m) => {
    const mentionNames: string[] = []
    if (Array.isArray(m.mentions)) {
      for (const uid of m.mentions) {
        if (typeof uid === 'string') {
          const n = idToName.get(uid)
          if (n) mentionNames.push(n)
        }
      }
    }
    return renderMessage(m, m.sender.name, mentionNames)
  })

  // ── 3. MiMo 归纳 → 严格 JSON ──
  const conversationLabel = conversation.name
    ? `${conversation.name}（${conversation.type}）`
    : `会话 ${conversation.id.slice(0, 8)}（${conversation.type}）`
  const prompt = buildPrompt(conversationLabel, Array.from(idToName.values()), messageLines)

  let minutes: MinutesResult
  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: '你是严谨的会议纪要整理助手，只输出严格 JSON。' },
        { role: 'user', content: prompt },
      ],
      { max_completion_tokens: 3000, temperature: 0.3, timeoutMs: 90_000 },
    )
    const parsed = extractJsonObject(res.content ?? '')
    if (!parsed) {
      throw new ApiError(502, 'AI 归纳结果无法解析，请稍后重试', 'AI_BAD_MINUTES')
    }
    minutes = normalizeMinutes(parsed)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw miMoToApiError(err)
  }

  // ── 4. 事务落库 ──
  // 项目解析：Conversation.projectId 优先（模型无 phase 关联，SINGLE/GROUP 无项目 → 纪要仅会话维度）
  const projectId = conversation.projectId

  const result = await prisma.$transaction(async (tx) => {
    // 4a. 名字 → userId 匹配池：项目成员（有项目）/ 会话成员（无项目）
    let nameToUserId = new Map<string, string>()
    let fallbackOwnerId: string | null = null // 无匹配时待办归属：项目负责人 / 发起人自己
    if (projectId) {
      const members = await tx.projectMember.findMany({
        where: { projectId },
        select: { user: { select: { id: true, name: true } }, role: true },
      })
      nameToUserId = new Map(members.map((m) => [m.user.name, m.user.id]))
      fallbackOwnerId =
        members.find((m) => m.role === 'OWNER')?.user.id ?? members[0]?.user.id ?? user.userId
    } else {
      nameToUserId = new Map(participants.map((p) => [p.user.name, p.user.id]))
      fallbackOwnerId = user.userId
    }

    // 4b. 项目会话：找/建「会议纪要」目录 + FileRequirement 条目
    let fileRequirementId: string | null = null
    let projectCode: string | null = null
    if (projectId) {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { code: true },
      })
      projectCode = project?.code ?? null

      let catalog = await tx.fileCatalog.findFirst({
        where: { projectId, name: MINUTES_CATALOG_NAME, parentId: null },
        select: { id: true },
      })
      if (!catalog) {
        catalog = await tx.fileCatalog.create({
          data: { projectId, name: MINUTES_CATALOG_NAME, phaseCode: null, order: 998 },
        })
      }

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const remarkParts: string[] = []
      if (minutes.summary) remarkParts.push(minutes.summary)
      if (minutes.decisions.length > 0) {
        remarkParts.push('结论：\n' + minutes.decisions.map((d) => `· ${d}`).join('\n'))
      }
      if (minutes.actionItems.length > 0) {
        remarkParts.push(
          '待办：\n' +
            minutes.actionItems
              .map((a) => `· ${a.content}${a.assigneeName ? `（${a.assigneeName}）` : ''}${a.due ? ` 截止 ${a.due}` : ''}`)
              .join('\n'),
        )
      }
      const fr = await tx.fileRequirement.create({
        data: {
          projectId,
          catalogId: catalog.id,
          name: minutes.title,
          code: `MEE-${conversationId.slice(0, 8)}-${dateStr}`,
          required: false,
          ownerId: user.userId,
          purpose: '会议纪要（AI 整理）',
          scope: 'PUBLIC',
          status: 'WAITING',
          remark: remarkParts.join('\n\n') || null,
        },
      })
      fileRequirementId = fr.id

      await tx.activityLog.create({
        data: {
          projectId,
          userId: user.userId,
          action: 'ai.meeting-minutes',
          detail: {
            conversationId,
            requirementId: fr.id,
            title: minutes.title,
            actionItemCount: minutes.actionItems.length,
          } as Prisma.InputJsonValue,
        },
      })
    }

    // 4c. actionItems → TodoItem + 通知（归属：名字匹配 → 项目负责人 → 发起人）
    const notified: Array<{ userId: string; content: string }> = []
    const seen = new Set<string>()
    const resolvedActionItems: Array<NormalizedActionItem & { assigneeId: string | null }> = []
    for (const item of minutes.actionItems) {
      const assigneeId = item.assigneeName
        ? nameToUserId.get(item.assigneeName) ?? null
        : null
      resolvedActionItems.push({ ...item, assigneeId })
      const target = assigneeId ?? fallbackOwnerId
      if (!target || seen.has(target + item.content)) continue
      seen.add(target + item.content)

      const convLabel = projectCode ? `项目 ${projectCode}` : conversationLabel
      const link = fileRequirementId
        ? `/files?projectId=${projectId}&requirementId=${fileRequirementId}`
        : `/messages?conversation=${conversationId}`
      await tx.todoItem.create({
        data: {
          userId: target,
          title: `【会议待办】${item.content}`,
          sourceType: 'MESSAGE',
          sourceId: fileRequirementId ?? conversationId,
          link,
          dueAt: item.due ? new Date(`${item.due}T23:59:59+08:00`) : null,
          priority: 'MEDIUM',
        },
      })
      await tx.notification.create({
        data: {
          userId: target,
          type: 'SYSTEM',
          title: '您有一条会议待办',
          body: `${convLabel}「${minutes.title}」会议纪要已生成：${item.content}`,
          link,
        },
      })
      await tx.$executeRaw`SELECT pg_notify('im_events', ${JSON.stringify({
        event: 'notify:push',
        userId: target,
        title: '您有一条会议待办',
        body: `${convLabel}「${minutes.title}」会议纪要已生成：${item.content}`,
        link,
      })})`
      notified.push({ userId: target, content: item.content })
    }

    return {
      fileRequirementId,
      actionItemCount: minutes.actionItems.length,
      notifiedCount: notified.length,
      projectCode,
    }
  })

  return ok({
    fileRequirementId: result.fileRequirementId,
    actionItemCount: result.actionItemCount,
    notifiedCount: result.notifiedCount,
    title: minutes.title,
    summary: minutes.summary,
    decisions: minutes.decisions,
    actionItems: minutes.actionItems,
  })
})
