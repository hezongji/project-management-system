'use client'

/**
 * mobile/ —— 移动端通用组件库（(main) 下 12 页面复用）。
 * 与 im-mobile（IM 业务专用组件树）独立，模式一致（微信式卡片列表/底部抽屉/安全区）。
 */

export { MobileTabBar, type MobileTabBarItem } from './tab-bar'
export { MobilePageHeader } from './page-header'
export { MobileList, MobileListItem } from './list'
export { MobileStatusChip, type MobileChipTone } from './status-chip'
export { MobileEmptyState } from './empty-state'
export { MobileSearchBar } from './search-bar'
export { MobileFab } from './fab'
export { MobileSegmentedTabs, type MobileSegmentedTab } from './segmented-tabs'
export { MobileCard } from './card'
export { MobileMoreSheet } from './more-sheet'
export { Sheet as MobileSheet } from '@/components/ui/sheet'
export { MobilePurchase, type MobilePurchaseProps } from './purchase'
export { ResponsiveDialog, ResponsiveDialogContent } from './responsive-dialog'
