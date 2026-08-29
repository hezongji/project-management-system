/**
 * AI 工具权限跟随单测（★ 2026-08-22 生产加固批次）
 * 铁律验证：AI 只能通过 executeTool 查数据，所有工具套用 data-visibility 过滤 + 脱敏。
 * 覆盖：
 *   - query_my_projects：MEMBER 仅可见成员项目（过滤条件落到 prisma 查询源头）
 *   - query_purchase_orders：无金额权限用户金额字段脱敏为 null；ADMIN 可见
 */

jest.mock('../prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    purchaseScopeGrant: { findMany: jest.fn() },
    project: { findMany: jest.fn() },
    purchaseOrder: { count: jest.fn(), findMany: jest.fn() },
    todoItem: { findMany: jest.fn() },
  },
}))

jest.mock('../phase-engine', () => ({
  computeProjectProgress: jest.fn().mockResolvedValue(42),
}))

import { prisma } from '../prisma'
import { executeTool } from '../ai/tools'
import type { AuthUser } from '../auth'

const mockedUser = prisma.user.findUnique as jest.Mock
const mockedGrants = prisma.purchaseScopeGrant.findMany as jest.Mock
const mockedProjects = prisma.project.findMany as jest.Mock
const mockedPoCount = prisma.purchaseOrder.count as jest.Mock
const mockedPoFind = prisma.purchaseOrder.findMany as jest.Mock

/** MEMBER：技术部工程师，无任何采购单据授权 */
const memberAuth: AuthUser = { userId: 'u-member', email: 'm@y.com', role: 'MEMBER' }
/** ADMIN：全量 + 金额可见 */
const adminAuth: AuthUser = { userId: 'u-admin', email: 'a@y.com', role: 'ADMIN' }

beforeEach(() => {
  jest.clearAllMocks()
})

describe('query_my_projects：项目可见性过滤', () => {
  it('MEMBER：过滤条件（members.some.userId）落到 prisma 查询源头', async () => {
    mockedProjects.mockResolvedValue([
      { id: 'p1', code: 'DEMO25001', name: '成员项目', status: 'IN_PROGRESS', isArchived: false },
    ])
    const out = await executeTool('query_my_projects', {}, memberAuth)
    const json = JSON.parse(out)
    // 权限跟随：查询 where 必须含成员过滤（不可见=不可达，过滤在源头）
    expect(mockedProjects).toHaveBeenCalledWith(
      expect.objectContaining({ where: { members: { some: { userId: 'u-member' } } } }),
    )
    expect(json.total).toBe(1)
    expect(json.projects[0].code).toBe('DEMO25001')
  })

  it('ADMIN：过滤条件为空对象（全量可见）', async () => {
    mockedProjects.mockResolvedValue([
      { id: 'p9', code: 'DEMO25999', name: '任意项目', status: 'DONE', isArchived: true },
    ])
    const out = await executeTool('query_my_projects', {}, adminAuth)
    JSON.parse(out)
    expect(mockedProjects).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    )
  })

  it('工具内部错误不抛出，返回 { error } JSON 供模型优雅解释', async () => {
    mockedProjects.mockRejectedValue(new Error('db down'))
    const out = await executeTool('query_my_projects', {}, memberAuth)
    const json = JSON.parse(out)
    expect(json.error).toBe(true)
    expect(typeof json.message).toBe('string')
  })
})

describe('query_purchase_orders：金额脱敏（maskPurchaseFinance）', () => {
  /** 技术部工程师 + 无授权 → canViewPurchaseFinanceOf=false */
  function asNonFinanceMember() {
    mockedUser.mockResolvedValue({ department: { name: '技术部' }, purchaseFinanceGranted: false })
    mockedGrants.mockResolvedValue([])
  }
  /** 订单样例 */
  const order = {
    id: 'po1',
    code: 'CG-DEMO25001-001',
    title: '电机采购',
    category: 'MECHANICAL',
    status: 'ORDERED',
    isSupplementary: false,
    supplementaryReason: null,
    orderDate: new Date('2026-08-01'),
    plannedArrivalDate: new Date('2026-08-20'),
    amount: 1234.5,
    settlementAmount: 1100,
    remark: null,
    project: { code: 'DEMO25001', name: '一期' },
    supplier: { name: '某供应商' },
    items: [{ name: '三相电机', quantity: 2, receivedQty: 0 }],
    arrivals: [{ batchNo: 'CG-DEMO25001-001-1', arrivalDate: new Date('2026-08-10'), status: 'PARTIAL' }],
  }

  it('MEMBER 无金额权限：financeVisible=false，amount/settlementAmount 脱敏为 null', async () => {
    asNonFinanceMember()
    mockedPoCount.mockResolvedValue(1)
    mockedPoFind.mockResolvedValue([order])
    const out = await executeTool('query_purchase_orders', {}, memberAuth)
    const json = JSON.parse(out)
    expect(json.financeVisible).toBe(false)
    expect(json.orders[0].amount).toBeNull()
    expect(json.orders[0].settlementAmount).toBeNull()
    expect(json.orders[0].code).toBe('CG-DEMO25001-001') // 非金额字段保留
    expect(json.orders[0].items[0].quantity).toBe(2)
  })

  it('ADMIN：financeVisible=true，金额原样保留', async () => {
    mockedPoCount.mockResolvedValue(1)
    mockedPoFind.mockResolvedValue([order])
    const out = await executeTool('query_purchase_orders', {}, adminAuth)
    const json = JSON.parse(out)
    expect(json.financeVisible).toBe(true)
    expect(json.orders[0].amount).toBe(1234.5)
    expect(json.orders[0].settlementAmount).toBe(1100)
  })

  it('MEMBER 可见性过滤：非 ADMIN 的 where 必含发布人/授权 OR 链（非空）', async () => {
    asNonFinanceMember()
    mockedPoCount.mockResolvedValue(0)
    mockedPoFind.mockResolvedValue([])
    await executeTool('query_purchase_orders', {}, memberAuth)
    expect(mockedPoFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
    )
  })
})
