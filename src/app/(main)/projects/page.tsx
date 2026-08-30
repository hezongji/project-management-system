'use client'

import { PageGuard } from '@/components/layout/page-guard'
import { MobileFab } from '@/components/mobile/fab'
import { MobileSearchBar } from '@/components/mobile/search-bar'
import { MobileEmptyState } from '@/components/mobile/empty-state'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { TablePagination } from '@/components/ui/data-table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ProjectService } from '@/services'
import { Project } from '@/types'
import { formatRelativeTime, formatDate } from '@/lib/utils'
import { label, PROJECT_STATUS, PRIORITY } from '@/lib/labels'
import { 
  Plus, 
  Search, 
  Filter, 
  Users, 
  Calendar, 
  TrendingUp,
  FolderOpen,
  Layers,
  Building2,
  Banknote,
  FileUp
} from 'lucide-react'

function ProjectsPageInner() {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  // 创建项目权限：ADMIN / 项目经理（PROJECT_MANAGER）
  const canCreate =
    user?.role === 'ADMIN' || user?.role === 'PROJECT_MANAGER'
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const { data: projectsData, isLoading } = useQuery({
    queryKey: ['projects', { searchTerm, statusFilter, sortBy, sortOrder, page }],
    queryFn: () => ProjectService.getProjects({
      page,
      limit: 20,
      search: searchTerm,
      sortBy,
      sortOrder,
      ...(statusFilter !== 'all' && { status: statusFilter }),
    }),
  })

  const projects = projectsData?.data?.projects || []
  const pagination = projectsData?.data?.pagination

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return 'default'
      case 'COMPLETED':
        return 'secondary'
      case 'ON_HOLD':
        return 'outline'
      case 'CANCELLED':
        return 'destructive'
      default:
        return 'secondary'
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'URGENT':
        return 'destructive'
      case 'HIGH':
        return 'destructive'
      case 'MEDIUM':
        return 'default'
      case 'LOW':
        return 'secondary'
      default:
        return 'secondary'
    }
  }

  return (
    <div className="space-y-6">
        {/* Header（统一标题区） */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">项目</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              管理和跟踪您的所有项目
            </p>
          </div>
          {canCreate && (
            <Button className="hidden lg:inline-flex" onClick={() => router.push('/projects/new')}>
              <Plus className="mr-2 h-4 w-4" />
              新建项目
            </Button>
          )}
        </div>

        {/* 移动端工具行：搜索 + 状态横滑 chips */}
        <div className="space-y-2 lg:hidden">
          <MobileSearchBar
            value={searchTerm}
            onChange={(v) => { setSearchTerm(v); setPage(1) }}
            placeholder="搜索项目..."
          />
          <div
            className="-mx-3 flex gap-2 overflow-x-auto px-3"
            style={{ scrollbarWidth: 'none' }}
          >
            {([
              { k: 'all', t: '全部' },
              { k: 'ACTIVE', t: '进行中' },
              { k: 'COMPLETED', t: '已完成' },
              { k: 'ON_HOLD', t: '暂停' },
              { k: 'CANCELLED', t: '已取消' },
            ] as const).map((c) => {
              const active = statusFilter === c.k
              return (
                <button
                  key={c.k}
                  type="button"
                  onClick={() => { setStatusFilter(c.k); setPage(1) }}
                  className={cn(
                    'flex h-10 min-w-16 shrink-0 items-center justify-center rounded-full border px-3 text-xs',
                    active
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {c.t}
                </button>
              )
            })}
          </div>
        </div>

        {/* Filters（桌面） */}
        <div className="hidden flex-wrap items-center gap-2 lg:flex">
          <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索项目..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1) }}
              className="pl-10"
            />
          </div>
          
          <Select
            value={statusFilter}
            onValueChange={(v) => { setStatusFilter(v); setPage(1) }}
          >
            <SelectTrigger className="h-10 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有状态</SelectItem>
              <SelectItem value="ACTIVE">进行中</SelectItem>
              <SelectItem value="COMPLETED">已完成</SelectItem>
              <SelectItem value="ON_HOLD">暂停</SelectItem>
              <SelectItem value="CANCELLED">已取消</SelectItem>
            </SelectContent>
          </Select>
          
          <Select
            value={`${sortBy}-${sortOrder}`}
            onValueChange={(v) => {
              const [field, order] = v.split('-')
              setSortBy(field)
              setSortOrder(order as 'asc' | 'desc')
            }}
          >
            <SelectTrigger className="h-10 w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt-desc">最新创建</SelectItem>
              <SelectItem value="createdAt-asc">最早创建</SelectItem>
              <SelectItem value="updatedAt-desc">最近更新</SelectItem>
              <SelectItem value="name-asc">名称 A-Z</SelectItem>
              <SelectItem value="name-desc">名称 Z-A</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Projects Grid */}
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-4 bg-muted rounded w-3/4"></div>
                  <div className="h-3 bg-muted rounded w-1/2"></div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="h-3 bg-muted rounded"></div>
                    <div className="h-3 bg-muted rounded w-5/6"></div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((project: Project) => (
              <Card key={project.id} className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => router.push(`/projects/${project.id}`)}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="text-xs font-mono font-semibold text-primary mb-1">{project.code}</div>
                      <CardTitle className="text-lg">{project.name}</CardTitle>
                      <CardDescription className="mt-1">
                        {project.description}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {/* Status and Priority */}
                    <div className="flex items-center space-x-2">
                      <Badge variant={getStatusColor(project.status)}>
                        {label(PROJECT_STATUS, project.status)}
                      </Badge>
                      <Badge variant={getPriorityColor(project.priority)}>
                        {label(PRIORITY, project.priority)}
                      </Badge>
                      {project.isArchived && (
                        <Badge variant="outline" className="text-muted-foreground">已归档</Badge>
                      )}
                    </div>
                    
                    {/* 客户 / 合同金额（P2-6：提升列表信息密度） */}
                    {(project.customer?.name || project.amount != null) && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex min-w-0 items-center text-muted-foreground">
                          <Building2 className="mr-1 h-4 w-4 shrink-0" />
                          <span className="truncate">{project.customer?.name ?? '—'}</span>
                        </span>
                        {project.amount != null && (
                          <span className="flex shrink-0 items-center font-medium">
                            <Banknote className="mr-1 h-4 w-4 text-muted-foreground" />
                            ¥{Number(project.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 阶段统计（替代原进度条：schema 无 progress 字段，恒 0% 会误导） */}
                    <div className="flex items-center text-sm text-muted-foreground">
                      <Layers className="h-4 w-4 mr-1" />
                      <span>{project._count?.phases ?? 0} 个阶段</span>
                    </div>
                    
                    {/* Dates */}
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <div className="flex items-center">
                        <Calendar className="h-4 w-4 mr-1" />
                        <span>{project.plannedStart ? formatDate(project.plannedStart) : '未设置'}</span>
                      </div>
                      <div className="flex items-center">
                        <TrendingUp className="h-4 w-4 mr-1" />
                        <span>{project.plannedEnd ? formatDate(project.plannedEnd) : '未设置'}</span>
                      </div>
                    </div>
                    
                    {/* Team */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <Users className="h-4 w-4 mr-1 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                          {project._count?.members ?? project.members?.length ?? 0} 成员
                        </span>
                      </div>
                      <div className="flex items-center">
                        <FolderOpen className="h-4 w-4 mr-1 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                          {project._count?.tasks ?? 0} 任务
                        </span>
                      </div>
                    </div>

                    {/* 文件提交进度（2026-08-21） */}
                    {project.fileStats && project.fileStats.total > 0 && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <FileUp className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">文件</span>
                        </div>
                        <span
                          className={
                            project.fileStats.submitted === project.fileStats.total
                              ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                          }
                        >
                          {project.fileStats.submitted}/{project.fileStats.total} 已提交
                        </span>
                      </div>
                    )}
                    
                    {/* Last updated */}
                    <div className="text-xs text-muted-foreground">
                      最后更新：{formatRelativeTime(project.updatedAt)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* 分页 */}
        {!isLoading && pagination && pagination.total > 0 && (
          <TablePagination
            page={pagination.page}
            pages={pagination.pages}
            total={pagination.total}
            onPageChange={setPage}
          />
        )}
        
        {projects.length === 0 && !isLoading && (
          <div className="hidden text-center py-12 lg:block">
            <FolderOpen className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2">暂无项目</h3>
            <p className="text-muted-foreground mb-4">
              {searchTerm ? '没有找到匹配的项目' : '开始创建您的第一个项目'}
            </p>
            {!searchTerm && canCreate && (
              <Button onClick={() => router.push('/projects/new')}>
                <Plus className="mr-2 h-4 w-4" />
                创建项目
              </Button>
            )}
          </div>
        )}

        {/* 移动端空态 */}
        {projects.length === 0 && !isLoading && (
          <div className="lg:hidden">
            <MobileEmptyState
              icon={FolderOpen}
              title={searchTerm ? '没有找到匹配的项目' : '暂无项目'}
              desc={searchTerm ? '换个关键词试试' : '点击右下角按钮创建第一个项目'}
              action={
                !searchTerm && canCreate ? (
                  <button
                    type="button"
                    onClick={() => router.push('/projects/new')}
                    className="btn-gradient h-11 rounded-md px-6 text-sm text-primary-foreground"
                  >
                    创建项目
                  </button>
                ) : undefined
              }
            />
          </div>
        )}

        {/* 移动端 FAB：新建项目（bottom-20 避开 Tab 栏） */}
        {canCreate && (
          <MobileFab icon={Plus} label="新建项目" onClick={() => router.push('/projects/new')} />
        )}
    </div>
  )
}

export default function ProjectsPage() {
  return (
    <PageGuard pageKey="projects">
      <ProjectsPageInner />
    </PageGuard>
  )
}
