// POST /api/ai/explain-file — 文件条目 AI 解读（通俗解释 用途/要点/风险/建议下一步）
// 设计：docs/设计方案-AI智能助手.md §五。只读：条目可见性套 visibleRequirementFilter（与 files 页同口径）。
// body: { fileRequirementId }  →  { requirement, explanation }
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiHandler, ok, fail, requireAuth, ApiError } from '@/lib/api-helpers'
import { prisma } from '@/lib/prisma'
import { visibleRequirementFilter } from '@/lib/permission'
import { chatCompletion } from '@/lib/ai/mimo'
import { checkAiRateLimit } from '@/lib/ai-rate-limit'
import { assertAiConfigured, miMoToApiError } from '@/lib/ai/api-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const BodySchema = z.object({
  fileRequirementId: z.string().min(1, 'fileRequirementId 必填'),
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = requireAuth(request)
  const rl = checkAiRateLimit(authUser.userId)
  if (!rl.allowed) {
    return fail(429, `AI 使用太频繁，请稍后再试（约 ${rl.retryAfterSec} 秒后恢复）`, 'AI_RATE_LIMITED')
  }
  assertAiConfigured()
  const { fileRequirementId } = BodySchema.parse(await request.json())

  // 可见性跟随：不可见 = 不可达（404）
  const visWhere = await visibleRequirementFilter(authUser.userId)
  const fr = await prisma.fileRequirement.findFirst({
    where: { AND: [visWhere, { id: fileRequirementId }] },
    select: {
      id: true,
      name: true,
      code: true,
      required: true,
      purpose: true,
      status: true,
      dueDate: true,
      phaseCode: true,
      remark: true,
      owner: { select: { name: true } },
      project: { select: { code: true, name: true } },
    },
  })
  if (!fr) throw ApiError.notFound('文件条目不存在或您无权限查看')

  // 最新版本文件元数据（不解析二进制内容，仅名称/版本/类型/大小作解读信号）
  const latestFile = await prisma.file.findFirst({
    where: { requirementId: fr.id },
    orderBy: { version: 'desc' },
    select: { name: true, version: true, mimeType: true, size: true, createdAt: true },
  })

  const today = new Date().toISOString().slice(0, 10)
  const prompt = [
    '你是项目管理系统的 AI 助手。基于下方文件交付条目的真实信息，做通俗解读。',
    '要求：按四段输出，每段 1-3 行，用简体中文：',
    '1.【是什么】这份文件/条目的用途与定位（结合 purpose、项目、阶段推测，注明是推测）',
    '2.【要点】关键信息（状态/截止/责任人/必需性）',
    '3.【风险】可能的问题（临近截止未提交/已驳回/长期 WAITING 等，仅基于数据的客观信号，没有写「暂无明显风险」）',
    '4.【建议下一步】给责任人的具体行动建议',
    `今天是 ${today}。严禁编造数据中不存在的信息；信息不足时如实说明。`,
    '',
    '文件条目数据（JSON）：',
    JSON.stringify({
      entry: {
        name: fr.name,
        code: fr.code,
        purpose: fr.purpose,
        status: fr.status,
        required: fr.required,
        dueDate: fr.dueDate?.toISOString() ?? null,
        phase: fr.phaseCode,
        owner: fr.owner?.name ?? null,
        remark: fr.remark,
        project: fr.project ? `${fr.project.code} ${fr.project.name}` : null,
      },
      latestFile: latestFile
        ? {
            name: latestFile.name,
            version: latestFile.version,
            mimeType: latestFile.mimeType,
            sizeBytes: latestFile.size,
            uploadedAt: latestFile.createdAt.toISOString(),
          }
        : null,
    }),
  ].join('\n')

  let explanation: string
  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: '请解读该文件条目' },
      ],
      { temperature: 0.3, max_completion_tokens: 1536, timeoutMs: 45000 },
    )
    explanation = res.content?.trim() || 'AI 未返回内容，请稍后重试'
  } catch (err) {
    throw miMoToApiError(err)
  }

  return ok({
    requirement: {
      id: fr.id,
      name: fr.name,
      code: fr.code,
      status: fr.status,
      project: fr.project ? `${fr.project.code} ${fr.project.name}` : null,
      latestFileVersion: latestFile?.version ?? null,
    },
    explanation,
  })
})
