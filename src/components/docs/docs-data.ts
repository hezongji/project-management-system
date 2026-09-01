/**
 * 文档站内容数据（P2-1，对标 Kaneo docs）
 *
 * 纯静态结构化内容数组：不依赖 MDX/contentlayer（服务器内存有限，零新增依赖），
 * 页面/渲染器据此自动渲染。内容依据系统实际功能与 docs/ 目录整理，
 * 部署指南栏目的完整细节指向 docs/deployment.md（单一事实来源，避免两份维护）。
 *
 * 新增/调整栏目时只改本文件，页面与导航自动更新。
 */

import {
  FolderKanban,
  CheckSquare,
  ShoppingCart,
  Receipt,
  FolderOpen,
  MessageSquare,
  Smartphone,
  Plug,
  Rocket,
  Server,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react'

// ───────────────────────────── 内容块模型 ─────────────────────────────

/** 提示框变体 */
export type CalloutVariant = 'info' | 'tip' | 'warn'

/**
 * 内容块（结构化渲染的最小单元）。
 * 用联合类型覆盖：段落 / 标题 / 列表 / 代码 / 表格 / 提示框 / 外链。
 */
export type DocsBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'code'; lang?: string; code: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | {
      type: 'callout'
      variant?: CalloutVariant
      title?: string
      text: string
    }

/** 单个文档栏目（一个 slug 对应一页） */
export interface DocsSection {
  /** URL slug（/docs/[slug]） */
  slug: string
  /** 栏目标题 */
  title: string
  /** 一句话简介（SEO description + 首页卡片描述） */
  description: string
  /** 图标（侧边栏 / 首页卡片） */
  icon: LucideIcon
  /** 导航分组 */
  group: string
  /** 首页卡片是否显示「新」角标 */
  badge?: string
  /** 内容块序列 */
  blocks: DocsBlock[]
}

/** 导航分组（侧边栏渲染顺序） */
export interface DocsGroup {
  label: string
  slug: string
}

/** 侧边栏分组顺序（功能介绍 8 子栏目归一组） */
export const DOCS_GROUPS: DocsGroup[] = [
  { label: '功能介绍', slug: 'features' },
  { label: '快速开始', slug: 'quickstart' },
  { label: '部署指南', slug: 'deployment' },
  { label: '常见问题', slug: 'faq' },
]

// ───────────────────────────── 栏目内容 ─────────────────────────────

export const DOCS_SECTIONS: DocsSection[] = [
  // ─────────────────────────── 功能介绍 ───────────────────────────
  {
    slug: 'project',
    title: '项目管理',
    description:
      '项目全生命周期管理：项目、阶段、流程模板、甘特图与统计图表，成员与权限精细化控制。',
    icon: FolderKanban,
    group: 'features',
    blocks: [
      { type: 'p', text: '项目模块是系统的主干：以「项目」为组织单元，向下拆分「阶段」，阶段下挂「任务」，文件、采购、费用等资源都归属到具体项目，形成一套贯穿全生命周期的工程管理闭环。' },
      { type: 'h2', text: '项目与阶段' },
      {
        type: 'list',
        items: [
          '项目：编码 + 名称 + 起止时间 + 归档状态；归档后项目只读，禁止再建任务或改数据。',
          '阶段（Phase）：项目内的里程碑拆分，带编码、负责人、进度；阶段状态机（未开始 / 进行中 / 已完成 / 已跳过）由任务变动自动驱动。',
          '任务必须挂阶段（历史任务可无阶段），阶段下建任务走阶段看板「+」入口。',
        ],
      },
      { type: 'h2', text: '流程模板' },
      {
        type: 'p',
        text: '流程模板把「一套阶段 + 阶段任务清单」固化为可复用模板，新建项目时一键套用，快速铺开标准流程，避免每次从零搭建。',
      },
      { type: 'h2', text: '视图' },
      {
        type: 'list',
        items: [
          '甘特图：按项目时间轴横向展示阶段与任务排期。',
          '表格视图：字段级筛选排序的任务总表。',
          '统计图表：项目进度、任务分布等可视化报表。',
        ],
      },
      {
        type: 'callout',
        variant: 'tip',
        title: '权限',
        text: '成员按角色（OWNER / MANAGER / 阶段负责人 / 成员 / VIEWER）获得不同操作权限，非 ADMIN 仅能看到自己所属项目的数据，权限隔离贯穿列表、详情、API 与 MCP。',
      },
    ],
  },
  {
    slug: 'tasks',
    title: '任务看板',
    description:
      '看板式任务管理：拖拽流转、任务挂阶段、修订历史可回滚、标注评论、文件要求提交跟踪。',
    icon: CheckSquare,
    group: 'features',
    blocks: [
      { type: 'p', text: '任务看板以列（TODO / IN_PROGRESS / REVIEW / DONE / CANCELLED）呈现任务，支持拖拽流转、指派负责人、设置优先级与截止时间。' },
      { type: 'h2', text: '修订历史' },
      {
        type: 'list',
        items: [
          '可修订字段白名单：标题 / 描述 / 状态 / 优先级 / 负责人 / 截止时间。',
          '每次重大变更生成一条修订记录（附快照 + 变更说明），可逐版查看。',
          '回滚 = 生成新修订：快照当前值后再恢复目标版本，全程留痕可审计。',
        ],
      },
      { type: 'h2', text: '协作细节' },
      {
        type: 'list',
        items: [
          '标注 / 评论：任务内随手记录与讨论，支持 @ 提及项目成员。',
          '文件要求：阶段可定义「需提交的文件清单」，任务行显示「已提交 X / Y」，追踪交付物完成度。',
          '状态语义自动化：进入进行中自动记 startedAt，完成自动记 completedAt。',
        ],
      },
      {
        type: 'callout',
        variant: 'info',
        title: '待办联动',
        text: '任务指派给你时，会自动生成一条个人待办（Todo），并在站内通知中心推送，桌面端页面隐藏时还有浏览器通知提醒。',
      },
    ],
  },
  {
    slug: 'purchase',
    title: '采购',
    description:
      '采购全流程：请购 → 订单 → 合同 → 收货 → 付款，供应商管理、采购编码自动生成。',
    icon: ShoppingCart,
    group: 'features',
    blocks: [
      { type: 'p', text: '采购模块覆盖工程企业采购的完整链路，单据之间层层关联，金额与进度可追溯。' },
      { type: 'h2', text: '核心单据流' },
      {
        type: 'list',
        ordered: true,
        items: [
          '采购请购（Purchase Request）：发起采购需求，审批立项。',
          '采购订单（Purchase Order）：对供应商下单，自动生成采购编码。',
          '采购合同（Purchase Contract）：与订单关联的合同台账。',
          '到货登记（Goods Arrival）：记录收货明细与数量。',
          '采购付款（Purchase Payment）：按进度登记付款。',
        ],
      },
      { type: 'h2', text: '供应商与外部主体' },
      {
        type: 'p',
        text: '供应商、外部组织统一纳入「外部主体」管理，请购与订单直接关联，避免重复录入；采购编码按规则自动生成，保证唯一可查。',
      },
      {
        type: 'callout',
        variant: 'tip',
        title: '权限',
        text: '采购单据同样受项目成员权限约束，非成员不可见；审批与操作按角色分级。',
      },
    ],
  },
  {
    slug: 'expense',
    title: '费用',
    description: '费用报销：费用类别管理、报销单提交与审批，按项目归集费用。',
    icon: Receipt,
    group: 'features',
    blocks: [
      { type: 'p', text: '费用模块管理项目相关的费用报销，把每一笔支出归集到项目，支撑成本核算。' },
      { type: 'h2', text: '费用类别' },
      {
        type: 'p',
        text: '管理员可维护费用类别（如差旅、材料、人工等），报销单按类别归类，统计口径统一。',
      },
      { type: 'h2', text: '报销单' },
      {
        type: 'list',
        items: [
          '填写报销单：选择项目与类别，填写金额、事由、票据说明。',
          '提交后进入审批流程，审批结果留痕。',
          '费用与项目关联，可在项目维度汇总查看。',
        ],
      },
    ],
  },
  {
    slug: 'drive',
    title: '网盘',
    description:
      '项目文件集中管理：目录树、上传下载、回收站 30 天保留、配额与 MIME 白名单控制。',
    icon: FolderOpen,
    group: 'features',
    blocks: [
      { type: 'p', text: '网盘（文件模块）把项目交付物集中存放，替代散落各处的文件传输，做到版本可回溯、误删可恢复。' },
      { type: 'h2', text: '目录与权限' },
      {
        type: 'list',
        items: [
          '按项目建立目录树，支持子目录嵌套与移动。',
          '删除文件夹需要 MANAGER 及以上权限，防误删整棵目录。',
          '上传按 MIME 白名单过滤，单文件大小与项目配额均可配。',
        ],
      },
      { type: 'h2', text: '回收站' },
      {
        type: 'p',
        text: '删除的文件进入回收站，默认保留 30 天（可通过环境变量调整），到期自动清理；保留期内可随时恢复。',
      },
      {
        type: 'callout',
        variant: 'warn',
        title: '下载打包',
        text: '目录批量下载走服务端 zip 打包，生产环境需留意 CJS 依赖（archiver）与内存占用，详见部署文档。',
      },
    ],
  },
  {
    slug: 'im',
    title: 'IM 即时通讯',
    description:
      '企业级 IM：单聊 / 群聊、实时消息、未读角标、桌面通知，与项目数据打通。',
    icon: MessageSquare,
    group: 'features',
    blocks: [
      { type: 'p', text: 'IM 是独立 Socket.IO 实时进程，与主服务共用 JWT 鉴权体系，消息实时推送、未读计数与桌面通知一应俱全。' },
      { type: 'h2', text: '能力' },
      {
        type: 'list',
        items: [
          '会话：单聊 / 群聊，消息支持文本、图片、文件。',
          '实时性：Socket.IO 长连接，消息即时送达，未读角标实时刷新。',
          '桌面通知：页面隐藏时弹浏览器通知（可在设置中关闭）。',
          '移动端：Android App 内嵌 IM，多端消息同步。',
        ],
      },
      {
        type: 'callout',
        variant: 'info',
        title: '架构',
        text: 'IM 服务独立进程（容器内 3002 端口），由 nginx/caddy 反向代理，与主服务（3000）解耦部署。',
      },
    ],
  },
  {
    slug: 'android',
    title: 'Android App',
    description:
      '原生 Android 壳（WebView）封装，扫码下载 APK，与系统数据实时同步，双 App 账号通用。',
    icon: Smartphone,
    group: 'features',
    blocks: [
      { type: 'p', text: 'Android App 以 Kotlin WebView 壳封装系统，提供两个独立 App：完整项目管理系统与 IM 聊天，登录账号与网页端通用。' },
      { type: 'h2', text: '获取与安装' },
      {
        type: 'list',
        ordered: true,
        items: [
          '访问 /download 下载页，扫描二维码获取 APK。',
          '自签名分发，安装时需允许「安装未知应用」。',
          'App 内登录 PM 系统账号即可使用。',
        ],
      },
      {
        type: 'callout',
        variant: 'warn',
        title: '注意',
        text: '微信内置浏览器会拦截 APK 下载，请用手机系统浏览器或相机扫码。',
      },
    ],
  },
  {
    slug: 'mcp',
    title: 'MCP 集成',
    description:
      '内置 MCP Server（/api/mcp），7 个只读/写工具，供 AI 编程代理连接，权限随用户隔离。',
    icon: Plug,
    group: 'features',
    blocks: [
      { type: 'p', text: '系统内置 MCP Server，端点 /api/mcp，基于标准 MCP 协议（JSON-RPC），AI 编程代理（Claude Code / Cursor / Codex / Pi 等）可直接连接，把项目与任务数据接入 AI 工作流。' },
      { type: 'h2', text: '提供的工具' },
      {
        type: 'list',
        items: [
          'list_projects / get_project：项目列表与详情。',
          'list_tasks / get_task：任务列表与详情。',
          'list_my_tasks：我负责的任务。',
          'create_task / update_task：创建与更新任务。',
        ],
      },
      { type: 'h2', text: '安全' },
      {
        type: 'p',
        text: 'MCP 复用项目的可见性过滤：ADMIN 全量读写，普通成员只读到所属项目数据、写操作被拒绝，权限隔离与 REST API 完全一致。',
      },
      { type: 'code', lang: 'json', code: '{\n  "mcpServers": {\n    "pm": {\n      "url": "https://pm.hezongji.cn/api/mcp",\n      "headers": { "Authorization": "Bearer <你的Token>" }\n    }\n  }\n}' },
      {
        type: 'callout',
        variant: 'info',
        title: '鉴权',
        text: '需携带 Bearer Token（与系统登录同一套 JWT），未认证访问会返回 401。',
      },
    ],
  },

  // ─────────────────────────── 快速开始 ───────────────────────────
  {
    slug: 'quickstart',
    title: '快速开始',
    description: '5 分钟上手：登录、建项目、搭阶段、派任务、传文件、发起采购与报销。',
    icon: Rocket,
    group: 'quickstart',
    blocks: [
      { type: 'p', text: '按下面的顺序走一遍，即可掌握系统的核心工作流。' },
      { type: 'h2', text: '1. 登录' },
      {
        type: 'list',
        items: [
          '演示账号 chenmuzhi / demo123456（在线体验 pm.hezongji.cn）。',
          '支持「拼音用户名 / 姓名 / 邮箱」三种写法登录，初始密码 123456。',
        ],
      },
      { type: 'h2', text: '2. 创建项目' },
      {
        type: 'list',
        items: [
          '工作台或项目列表点「新建项目」，填写名称、编码、起止时间。',
          '可直接套用流程模板，快速铺开标准阶段。',
        ],
      },
      { type: 'h2', text: '3. 搭建阶段与任务' },
      {
        type: 'list',
        items: [
          '在项目内添加阶段，设置负责人与进度。',
          '进入阶段看板，点「+」创建任务，指派负责人、定优先级与截止时间。',
        ],
      },
      { type: 'h2', text: '4. 协作与资源' },
      {
        type: 'list',
        items: [
          '任务内标注 / 评论、@ 成员讨论。',
          '在文件模块上传项目交付物，按目录归档。',
          '发起采购请购、登记费用报销。',
        ],
      },
      { type: 'h2', text: '5. 沟通与移动端' },
      {
        type: 'list',
        items: [
          'IM 模块发起单聊 / 群聊。',
          '/download 页扫码安装 Android App，随时处理待办。',
        ],
      },
      {
        type: 'callout',
        variant: 'tip',
        title: '下一步',
        text: '需要从零部署到自己的服务器？请看「部署指南」。想把项目数据接入 AI 代理？请看「MCP 集成」。',
      },
    ],
  },

  // ─────────────────────────── 部署指南 ───────────────────────────
  {
    slug: 'deployment',
    title: '部署指南',
    description:
      '从零到上线：一键部署脚本、HTTPS、环境变量、常见部署问题（完整文档见 docs/deployment.md）。',
    icon: Server,
    group: 'deployment',
    blocks: [
      {
        type: 'callout',
        variant: 'info',
        title: '单一事实来源',
        text: '完整的部署文档维护在仓库 docs/deployment.md（含详细步骤、环境变量表与 FAQ）。本节仅作速览，避免两份内容重复维护。',
      },
      { type: 'h2', text: '服务组成' },
      {
        type: 'table',
        headers: ['服务', '作用', '端口（容器内）'],
        rows: [
          ['postgres', 'PostgreSQL 16 数据库', '5432'],
          ['app', 'Next.js 主服务（页面 + REST API）', '3000'],
          ['im', 'Socket.IO 即时通讯', '3002'],
          ['nginx / caddy', '反向代理（HTTP / 自动 HTTPS）', '80 / 443'],
        ],
      },
      { type: 'h2', text: '一键部署' },
      {
        type: 'code',
        lang: 'bash',
        code: '# 1. 获取代码\ngit clone https://github.com/hezongji/project-management-system.git\ncd project-management-system\n\n# 2. 一键部署（交互询问站点地址，自动生成 .env 与密钥）\n./deploy/install.sh\n\n# 3. HTTPS 模式（Caddy 自动签发证书）\n./deploy/install.sh --https --domain pm.example.com',
      },
      { type: 'h2', text: '关键环境变量' },
      {
        type: 'list',
        items: [
          'DB_* / DATABASE_URL：数据库连接（必填）。',
          'JWT_SECRET：主服务与 IM 共用的 JWT 密钥，未配置将拒绝启动（必填）。',
          'NEXT_PUBLIC_WS_URL：IM WebSocket 地址，只能写 origin 根域名（不要带路径）。',
          'FILE_ROOT / FILE_MAX_SIZE / FILE_QUOTA_PER_PROJECT：网盘相关。',
          'WECOM_WEBHOOK_URL / DINGTALK_WEBHOOK_URL：企业微信 / 钉钉通知（可选）。',
        ],
      },
      { type: 'h2', text: '常见部署问题' },
      {
        type: 'list',
        items: [
          '内存不足 OOM：2 核 2G 起步，构建前先看 free -m 水位。',
          '前端空白 / 接口 404：确认 NEXT_PUBLIC_API_URL / WS_URL 正确。',
          '改代码后不生效：按端口 ss -tlnp 找 pid 强杀旧 next-server，再重启。',
        ],
      },
      {
        type: 'callout',
        variant: 'tip',
        title: '完整文档',
        text: '详见仓库 docs/deployment.md（从零到上线步骤 + 真实环境变量表 + FAQ）。',
      },
    ],
  },

  // ─────────────────────────── FAQ ───────────────────────────
  {
    slug: 'faq',
    title: '常见问题',
    description: '登录、任务修订、文件、IM、Android、部署等高频问题的解答。',
    icon: HelpCircle,
    group: 'faq',
    blocks: [
      { type: 'h2', text: '账号与登录' },
      {
        type: 'list',
        items: [
          '登录支持哪些写法？——拼音用户名 / 姓名 / 邮箱任选其一 + 密码。',
          '忘记密码怎么办？——联系管理员重置（评估期未开通邮件自助找回）。',
          '连续输错被锁定？——稍等片刻再试，或找管理员解锁。',
        ],
      },
      { type: 'h2', text: '任务与修订' },
      {
        type: 'list',
        items: [
          '改了任务但没生成修订？——普通小改动走 PATCH 不生成修订，重大变更走「修订」入口。',
          '能回滚任务吗？——可以，回滚会生成一条新修订（快照当前值），全程留痕。',
          '任务必须挂阶段吗？——新任务建议挂阶段，历史任务允许无阶段。',
        ],
      },
      { type: 'h2', text: '文件与网盘' },
      {
        type: 'list',
        items: [
          '上传失败？——检查文件是否超单文件上限（默认 100MB）或不在 MIME 白名单内。',
          '误删文件能找回吗？——回收站保留 30 天，期内可恢复。',
          '为什么删不了文件夹？——删除文件夹需 MANAGER 及以上权限。',
        ],
      },
      { type: 'h2', text: 'IM 与 Android' },
      {
        type: 'list',
        items: [
          '消息收不到 / 断连？——检查 NEXT_PUBLIC_WS_URL 是否为 origin 根域名（带路径会被当 namespace 导致断连）。',
          'Android 装不上？——微信内会拦截下载，换系统浏览器扫码；安装时允许「未知应用」。',
          'App 与网页账号通用吗？——通用，同一套 JWT 鉴权。',
        ],
      },
      { type: 'h2', text: '部署与 MCP' },
      {
        type: 'list',
        items: [
          '服务器 OOM？——2 核 2G 起步，构建前先看 free -m 水位。',
          'MCP 连接 401？——需带 Bearer Token（系统登录同一套 JWT）。',
          '完整部署步骤在哪？——docs/deployment.md。',
        ],
      },
    ],
  },
]

// ───────────────────────────── 索引 ─────────────────────────────

/** slug → section 索引 */
export const DOCS_INDEX: Record<string, DocsSection> = Object.fromEntries(
  DOCS_SECTIONS.map((s) => [s.slug, s]),
)
