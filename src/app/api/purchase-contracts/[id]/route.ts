import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ok, requireAuth, ApiError } from '@/lib/api-helpers'
import { getUserDeptName, isPurchaseDept } from '@/lib/data-visibility'
import { z } from 'zod'

/**
 * /api/purchase-contracts/[id] —— ★ V3 合同确认/作废（2026-08-22）
 *
 * PATCH body { action: 'CONFIRM' | 'VOID', voidReason? }
 *   CONFIRM：采购确认合同与价格（status→CONFIRMED，记 confirmedAt/ById）
 *   VOID：作废（voidReason 必填）
 * 仅采购部/ADMIN。
 */

const patchSchema = z.object({
  action: z.enum(['CONFIRM', 'VOID']),
  voidReason: z.string().trim().optional(),
})

export const PATCH = apiHandler(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const user = requireAuth(request)
  const deptName = await getUserDeptName(user.userId)
  if (user.role !== 'ADMIN' && !isPurchaseDept(deptName)) {
    throw ApiError.forbidden('仅采购部可确认/作废合同')
  }
  const raw = await request.json().catch(() => {
    throw ApiError.badRequest('请求体必须是 JSON')
  })
  const body = patchSchema.parse(raw)

  const contract = await prisma.purchaseContract.findUnique({ where: { id: id } })
  if (!contract) throw ApiError.notFound('合同不存在')
  if (contract.status === 'VOIDED') throw ApiError.badRequest('合同已作废')

  const updated = await prisma.purchaseContract.update({
    where: { id: id },
    data:
      body.action === 'CONFIRM'
        ? { status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: user.userId }
        : { status: 'VOIDED', voidReason: body.voidReason ?? '未填原因' },
  })

  return ok(updated, body.action === 'CONFIRM' ? '合同已确认' : '合同已作废')
})
