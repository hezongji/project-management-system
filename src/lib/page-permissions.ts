/**
 * 页面权限定义（权限 V2 —— 2026-08-21 管理员统一分配）
 *
 * 管理员在「系统管理 → 权限分配」给每个用户勾选可见页面；
 * 侧边栏按此过滤菜单，页面级 PageGuard 拦截直接 URL 访问。
 *
 * 规则：
 *   - 用户 pagePermissions 为 null（未单独配置）→ 按全局角色取默认页面集
 *   - 管理员配置后 → 仅显示勾选的页面（ADMIN 恒为全部页面，不可降级）
 *   - 管理组页面（organization/externals/job-titles/settings）默认仅 ADMIN
 */

export interface PageDef {
  key: string
  label: string
  group: string // 导航分组（侧边栏分组名）
  href: string
}

/** 全系统页面清单（管理员分配界面 + 侧边栏过滤共用） */
export const ALL_PAGES: PageDef[] = [
  { key: 'dashboard', label: '工作台', group: '总览', href: '/' },
  { key: 'projects', label: '项目列表', group: '项目', href: '/projects' },
  { key: 'tasks', label: '项目任务', group: '项目', href: '/tasks' },
  { key: 'process-templates', label: '流程模板', group: '项目', href: '/process-templates' },
  { key: 'charts', label: '统计图表', group: '项目', href: '/views/charts' },
  { key: 'files', label: '文件目录', group: '文件', href: '/files' },
  { key: 'purchase', label: '采购订单', group: '采购', href: '/purchase' },
  { key: 'messages', label: '消息', group: 'IM', href: '/messages' },
  { key: 'organization', label: '组织架构', group: '管理', href: '/organization' },
  { key: 'externals', label: '外部主体', group: '管理', href: '/organization/externals' },
  { key: 'job-titles', label: '岗位字典', group: '管理', href: '/organization/job-titles' },
  { key: 'settings', label: '系统管理', group: '管理', href: '/settings' },
]

const ALL_KEYS = ALL_PAGES.map((p) => p.key)
/** 管理组页面 key（默认仅 ADMIN） */
const ADMIN_ONLY_KEYS = ['organization', 'externals', 'job-titles', 'settings']

/** 角色默认页面集（未单独配置时的回退） */
export function defaultPagesForRole(role: string): string[] {
  if (role === 'ADMIN') return [...ALL_KEYS]
  if (role === 'PROJECT_MANAGER') {
    // ★ Step3：默认不含 purchase（采购订单页）——PM/MEMBER 均需管理员单独勾选
    // （V3 采购页定位为采购部工作台，见 docs/设计方案-采购管理-v3.md §四）
    return [
      'dashboard',
      'projects',
      'tasks',
      'process-templates',
      'charts',
      'files',
      'messages',
    ]
  }
  // MEMBER / 其他
  return ['dashboard', 'projects', 'tasks', 'files', 'messages']
}

/**
 * 解析用户最终可见页面集：
 * @param role 全局角色
 * @param pagePermissions 用户配置（null=按角色默认）
 */
export function resolveUserPages(
  role: string,
  pagePermissions: string[] | null | undefined,
): string[] {
  if (role === 'ADMIN') return [...ALL_KEYS] // ADMIN 恒全量
  if (Array.isArray(pagePermissions) && pagePermissions.length > 0) {
    // 过滤掉非法 key；管理组页面强制仅 ADMIN（防御管理员误授）
    return pagePermissions.filter(
      (k) => ALL_KEYS.includes(k) && !ADMIN_ONLY_KEYS.includes(k),
    )
  }
  return defaultPagesForRole(role)
}

/** 单页面判定：用户是否可见某页面 */
export function canAccessPage(
  role: string,
  pagePermissions: string[] | null | undefined,
  pageKey: string,
): boolean {
  return resolveUserPages(role, pagePermissions).includes(pageKey)
}

/** 页面清单校验工具（管理界面保存前） */
export function isValidPageKeys(keys: unknown): keys is string[] {
  return (
    Array.isArray(keys) && keys.every((k) => typeof k === 'string' && ALL_KEYS.includes(k))
  )
}
