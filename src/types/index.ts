export interface User {
  id: string
  email: string
  username?: string
  name?: string | null
  firstName?: string | null
  lastName?: string | null
  avatar?: string | null
  role: 'ADMIN' | 'MANAGER' | 'USER' | 'PROJECT_MANAGER' | 'MEMBER'
  isActive?: boolean
  emailVerified?: Date | null
  createdAt?: Date
  updatedAt?: Date
  lastLogin?: Date | null
  /** 权限 V2：最终可见页面 key 数组（管理员分配，ADMIN 恒全量） */
  pages?: string[]
  /** 部门（/api/auth/me 返回，采购模块用于判断采购部身份） */
  department?: { id: string; name: string } | null
  /** 权限 V2：管理员额外授权可见项目 id（超出成员制） */
  extraVisibleProjectIds?: string[]
}

export interface Project {
  id: string
  name: string
  description: string | null
  /** schema v1.1 编号（DEMO+年后两位+流水）；旧字段 key 仅为兼容保留 */
  code?: string
  /** @deprecated 旧 schema 字段，新接口返回 code */
  key: string
  color?: string | null
  status: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  /** @deprecated 旧 schema 字段，新接口返回 plannedStart/plannedEnd */
  startDate?: Date | null
  endDate?: Date | null
  plannedStart?: Date | string | null
  plannedEnd?: Date | string | null
  organizationId?: string
  isArchived?: boolean
  /** 合同金额（schema Decimal(14,2)，JSON 序列化为字符串） */
  amount?: string | number | null
  createdAt: Date
  updatedAt: Date
  customer?: { id: string; name: string } | null
  members?: ProjectMember[]
  tasks?: Task[]
  _count?: { phases?: number; tasks: number; members: number }
  /** 文件提交统计（2026-08-21）：submitted/total（total=0 无条目） */
  fileStats?: { submitted: number; total: number }
  /** 当前列表接口附加：当前用户在项目内的角色（非成员为 null） */
  myRole?: string | null
  /** @deprecated 旧 schema 字段，新接口不再返回进度，勿再渲染 */
  progress?: number
}

export interface ProjectMember {
  id: string
  projectId?: string
  userId: string
  user?: User | { id: string; name: string | null; email: string }
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'
  joinedAt?: Date
}

export interface Task {
  id: string
  title: string
  description: string
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE' | 'CANCELLED'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  type: 'TASK' | 'BUG' | 'FEATURE' | 'IMPROVEMENT' | 'EPIC'
  projectId: string
  project: Project
  assigneeId?: string
  assignee?: User
  reporterId: string
  reporter: User
  estimatedHours?: number
  actualHours?: number
  dueDate?: Date
  startDate?: Date
  completedAt?: Date
  parentTaskId?: string
  parentTask?: Task
  subtasks: Task[]
  tags: string[]
  attachments: Attachment[]
  comments: Comment[]
  timeEntries: TimeEntry[]
  createdAt: Date
  updatedAt: Date
  /** 阶段文件提交统计（2026-08-21 /tasks 附加）：submitted/total，null=无阶段或阶段无条目 */
  phaseFileStats?: { submitted: number; total: number } | null
  /** 项目总进度（2026-08-21 /tasks 附加，总览进度条用） */
  projectProgress?: number
}

export interface Attachment {
  id: string
  filename: string
  originalName: string
  mimetype: string
  size: number
  path: string
  uploadedBy: string
  uploadedByUser: User
  createdAt: Date
}

export interface Comment {
  id: string
  content: string
  taskId: string
  task: Task
  userId: string
  user: User
  createdAt: Date
  updatedAt: Date
}

export interface TimeEntry {
  id: string
  description: string
  hours: number
  date: Date
  taskId?: string
  task?: Task
  projectId: string
  project: Project
  userId: string
  user: User
  isBillable: boolean
  createdAt: Date
  updatedAt: Date
}

export interface Team {
  id: string
  name: string
  description: string
  leaderId: string
  leader: User
  members: TeamMember[]
  projects: Project[]
  createdAt: Date
  updatedAt: Date
}

export interface TeamMember {
  id: string
  teamId: string
  team: Team
  userId: string
  user: User
  role: 'leader' | 'admin' | 'member'
  joinedAt: Date
}

export interface Notification {
  id: string
  type: 'task_assigned' | 'task_updated' | 'task_completed' | 'comment_added' | 'project_updated' | 'team_invited' | 'mention' | 'system'
  title: string
  message: string
  userId: string
  user: User
  isRead: boolean
  data: any
  createdAt: Date
}

export interface Activity {
  id: string
  type: 'task_created' | 'task_updated' | 'task_completed' | 'comment_added' | 'project_created' | 'project_updated' | 'user_joined' | 'user_left'
  description: string
  userId: string
  user: User
  projectId?: string
  project?: Project
  taskId?: string
  task?: Task
  createdAt: Date
}

export interface DashboardStats {
  totalProjects: number
  activeProjects: number
  completedProjects: number
  totalTasks: number
  completedTasks: number
  overdueTasks: number
  totalTeamMembers: number
  activeTeamMembers: number
}

export interface ChartData {
  name: string
  value: number
  color?: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  message?: string
  errors?: string[]
}

export interface PaginationParams {
  page: number
  limit: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  search?: string
}

export interface PaginatedResponse<T> {
  success: boolean
  data: {
    /** §4 统一分页键（后端列表接口统一返回 items） */
    items?: T[]
    /** 旧键兼容（由 services 层从 items 映射，旧页面零改动） */
    projects?: T[]
    tasks?: T[]
    pagination?: {
      page: number
      limit: number
      total: number
      pages: number
      hasNext: boolean
      hasPrev: boolean
    }
    [key: string]: any
  }
  message?: string
  errors?: string[]
}

export interface FilterOptions {
  status?: string[]
  priority?: string[]
  assigneeId?: string[]
  projectId?: string[]
  type?: string[]
  tags?: string[]
  dateRange?: {
    start: Date
    end: Date
  }
}

export interface GanttTask {
  id: string
  name: string
  start: Date
  end: Date
  progress: number
  dependencies?: string[]
  color?: string
  assignee?: string
}

export interface SocketEvent {
  type: string
  payload: any
  timestamp: Date
}