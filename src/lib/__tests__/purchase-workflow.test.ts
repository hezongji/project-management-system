/**
 * 采购工作流核心单测（★ V3 2026-08-22）
 * 覆盖：状态转换白名单、canViewPurchaseFinance 新口径（去 OWNER/MANAGER）、maskPurchaseFinance
 */

import { ORDER_TRANSITIONS, ADVANCE_ACTIONS } from '../purchase-workflow'
import { canViewPurchaseFinance, maskPurchaseFinance } from '../data-visibility'

describe('purchase-workflow V3', () => {
  describe('ORDER_TRANSITIONS 状态白名单', () => {
    it('主链按 8 步工作流顺序推进', () => {
      expect(ORDER_TRANSITIONS.DRAFT).toContain('CONTRACT_PENDING')
      expect(ORDER_TRANSITIONS.CONTRACT_PENDING).toContain('CONFIRMED')
      expect(ORDER_TRANSITIONS.CONTRACT_PENDING).not.toContain('ORDERED') // 不能跳过合同确认
      expect(ORDER_TRANSITIONS.CONFIRMED).toContain('ORDERED')
      expect(ORDER_TRANSITIONS.ORDERED).toContain('PREPARING')
      expect(ORDER_TRANSITIONS.PREPARING).toContain('SHIPPED')
      expect(ORDER_TRANSITIONS.SHIPPED).toContain('PARTIAL')
      expect(ORDER_TRANSITIONS.PARTIAL).toContain('COMPLETED')
    })

    it('终态无出边', () => {
      expect(ORDER_TRANSITIONS.COMPLETED).toEqual([])
      expect(ORDER_TRANSITIONS.CANCELLED).toEqual([])
    })

    it('任意非终态可取消', () => {
      for (const s of ['DRAFT', 'CONTRACT_PENDING', 'CONFIRMED', 'ORDERED', 'PREPARING', 'SHIPPED', 'PARTIAL'] as const) {
        expect(ORDER_TRANSITIONS[s]).toContain('CANCELLED')
      }
    })

    it('COMPLETED 只能从 PARTIAL 进入', () => {
      const sources = Object.entries(ORDER_TRANSITIONS)
        .filter(([, tos]) => (tos as string[]).includes('COMPLETED'))
        .map(([from]) => from)
      expect(sources).toEqual(['PARTIAL'])
    })
  })

  describe('ADVANCE_ACTIONS 定义完备', () => {
    it('关键动作齐全且目标态正确', () => {
      expect(ADVANCE_ACTIONS.START_CONTRACT.to).toBe('CONTRACT_PENDING')
      expect(ADVANCE_ACTIONS.CONFIRM_CONTRACT.to).toBe('CONFIRMED')
      expect(ADVANCE_ACTIONS.PLACE_ORDER.to).toBe('ORDERED')
      expect(ADVANCE_ACTIONS.MARK_PREPARING.to).toBe('PREPARING')
      expect(ADVANCE_ACTIONS.MARK_SHIPPED.to).toBe('SHIPPED')
      expect(ADVANCE_ACTIONS.CANCEL.to).toBe('CANCELLED')
    })
  })

  describe('canViewPurchaseFinance V3 口径（去 OWNER/MANAGER）', () => {
    it('ADMIN / 财务部 / 采购部 可见', () => {
      expect(canViewPurchaseFinance('ADMIN', null, false)).toBe(true)
      expect(canViewPurchaseFinance('MEMBER', '财务部', false)).toBe(true)
      expect(canViewPurchaseFinance('MEMBER', '采购部', false)).toBe(true)
    })

    it('★ OWNER/MANAGER 不再默认可见（硬性要求 D）', () => {
      // v3 签名已无 memberRole 参数：普通成员即使传角色字符串也走 granted 判定
      expect(canViewPurchaseFinance('PROJECT_MANAGER', '技术部', false)).toBe(false)
      expect(canViewPurchaseFinance('MEMBER', '技术部', false)).toBe(false)
    })

    it('purchaseFinanceGranted=true（管理员勾选授权）可见', () => {
      expect(canViewPurchaseFinance('MEMBER', '技术部', true)).toBe(true)
    })
  })

  describe('maskPurchaseFinance 脱敏', () => {
    it('无权限时金额字段置 null，其他字段保留', () => {
      const obj = {
        code: 'CG-1',
        amount: 1000,
        paidAmount: 500,
        unitPrice: 20,
        title: '电气采购',
        paymentTerms: '预付30%',
      }
      const masked = maskPurchaseFinance(obj, false)
      expect(masked.amount).toBeNull()
      expect(masked.paidAmount).toBeNull()
      expect(masked.unitPrice).toBeNull()
      expect(masked.paymentTerms).toBeNull()
      expect(masked.code).toBe('CG-1')
      expect(masked.title).toBe('电气采购')
    })

    it('有权限时原样返回', () => {
      const obj = { amount: 1000, unitPrice: 20 }
      const out = maskPurchaseFinance(obj, true)
      expect(out.amount).toBe(1000)
      expect(out.unitPrice).toBe(20)
    })
  })
})
