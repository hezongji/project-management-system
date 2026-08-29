/**
 * 采购可见性 Step3 单测（★ 2026-08-22）
 * 覆盖：
 *   - defaultPagesForRole：PROJECT_MANAGER/MEMBER 默认不含 purchase（计划 Step3 要求）
 *   - visiblePurchaseOrderScope：发布人链路（supplierRequest→request→requesterId）修复
 *   - visibleSupplierRequestScope：发布人链路 + 单据授权精确匹配（替换原「任意 grant 行放行」）
 */

jest.mock('../prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    purchaseScopeGrant: { findMany: jest.fn() },
  },
}))

import { prisma } from '../prisma'
import {
  visiblePurchaseOrderScope,
  visibleSupplierRequestScope,
} from '../data-visibility'
import { defaultPagesForRole, ALL_PAGES } from '../page-permissions'

const mockedUser = prisma.user.findUnique as jest.Mock
const mockedGrants = prisma.purchaseScopeGrant.findMany as jest.Mock

/** 固定：非采购部普通用户（技术部工程师） */
function asEngineer() {
  mockedUser.mockResolvedValue({ department: { name: '技术部' } })
}
/** 固定：无任何单据授权 */
function noGrants() {
  mockedGrants.mockResolvedValue([])
}

describe('defaultPagesForRole：采购页默认角色集（Step3 缺口1）', () => {
  it('ADMIN 全量（含 purchase）', () => {
    expect(defaultPagesForRole('ADMIN')).toContain('purchase')
  })

  it('★ PROJECT_MANAGER 默认不含 purchase（需管理员单独勾选）', () => {
    expect(defaultPagesForRole('PROJECT_MANAGER')).not.toContain('purchase')
  })

  it('MEMBER 默认不含 purchase', () => {
    expect(defaultPagesForRole('MEMBER')).not.toContain('purchase')
  })

  it('purchase 页注册在 ALL_PAGES 的「采购」组', () => {
    const p = ALL_PAGES.find((x) => x.key === 'purchase')
    expect(p).toMatchObject({ label: '采购订单', group: '采购', href: '/purchase' })
  })
})

describe('visiblePurchaseOrderScope：发布人链路（Step3 缺口2 / S2 评审 B2 前置）', () => {
  it('普通工程师可见条件含 supplierRequest.request.requesterId 链路', async () => {
    asEngineer()
    noGrants()
    const where = await visiblePurchaseOrderScope('u1', 'MEMBER')
    const or = (where as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ creatorId: 'u1' })
    expect(or).toContainEqual({ ownerId: 'u1' })
    expect(or).toContainEqual({ receiverId: 'u1' })
    // ★ 发布人链路：经 supplierRequest → request → requesterId 能看到对应订单进度
    expect(or).toContainEqual({ supplierRequest: { request: { requesterId: 'u1' } } })
  })

  it('ADMIN / 采购部 → 全量 {}', async () => {
    expect(await visiblePurchaseOrderScope('u1', 'ADMIN')).toEqual({})
    mockedUser.mockResolvedValue({ department: { name: '采购部' } })
    expect(await visiblePurchaseOrderScope('u1', 'MEMBER')).toEqual({})
  })

  it('PURCHASE_ORDER 单据授权 → id in 列表', async () => {
    asEngineer()
    mockedGrants.mockResolvedValue([
      { scopeType: 'PURCHASE_ORDER', scopeId: 'o1' },
      { scopeType: 'PURCHASE_ORDER', scopeId: 'o2' },
    ])
    const where = await visiblePurchaseOrderScope('u1', 'MEMBER')
    const or = (where as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ id: { in: ['o1', 'o2'] } })
  })

  it('PURCHASE_ALL → 全量 {}', async () => {
    asEngineer()
    mockedGrants.mockResolvedValue([{ scopeType: 'PURCHASE_ALL', scopeId: null }])
    expect(await visiblePurchaseOrderScope('u1', 'MEMBER')).toEqual({})
  })
})

describe('visibleSupplierRequestScope：发布人链路 + 精确授权', () => {
  it('普通工程师可见 = 创建人 ∪ 溯源清单发布人（无成员项目分支）', async () => {
    asEngineer()
    noGrants()
    const where = await visibleSupplierRequestScope('u1', 'MEMBER')
    const or = (where as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ creatorId: 'u1' })
    expect(or).toContainEqual({ request: { requesterId: 'u1' } })
    expect(JSON.stringify(where)).not.toContain('project')
  })

  it('PURCHASE_REQUEST 授权 → 只放开对应清单派生的任务（非全量）', async () => {
    asEngineer()
    mockedGrants.mockResolvedValue([{ scopeType: 'PURCHASE_REQUEST', scopeId: 'req1' }])
    const where = await visibleSupplierRequestScope('u1', 'MEMBER')
    const or = (where as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ request: { id: { in: ['req1'] } } })
  })
})
