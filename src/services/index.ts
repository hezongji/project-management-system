import { ApiService, PaginatedApiService } from './api'
import { User, Project, Task, Notification, DashboardStats, PaginationParams, FilterOptions } from '@/types'

export class AuthService {
  static async login(email: string, password: string) {
    return ApiService.post<{ user: User; token: string }>('/auth/login', { email, password })
  }

  static async register(userData: { email: string; password: string; name: string }) {
    return ApiService.post<{ user: User; token: string }>('/auth/register', userData)
  }

  static async getCurrentUser() {
    return ApiService.get<User>('/auth/me')
  }

  // ── P1-5 清理：以下方法均无对应后端，已移除 ──
  // forgotPassword → 后端无 /auth/forgot-password（页面改为「请联系管理员重置」）
  // resetPassword → 后端无 /auth/reset-password（改用 AdminService.resetUserPassword）
  // verifyEmail → 后端无 /auth/verify-email
  // updateProfile → 后端无 /auth/profile
  // changePassword → 后端无 /auth/change-password
}

export class ProjectService {
  static async getProjects(pagination: PaginationParams, filters?: FilterOptions) {
    // listKey='projects'：后端统一返回 data.items，这里映射回旧键供旧页面消费
    return PaginatedApiService.getPaginated<Project>('/projects', pagination, filters, 'projects')
  }

  static async getProject(id: string) {
    return ApiService.get<Project>(`/projects/${id}`)
  }

  static async createProject(projectData: Partial<Project>) {
    return ApiService.post<Project>('/projects', projectData)
  }

  static async updateProject(id: string, projectData: Partial<Project>) {
    return ApiService.put<Project>(`/projects/${id}`, projectData)
  }

  static async deleteProject(id: string) {
    return ApiService.delete(`/projects/${id}`)
  }

  static async getProjectMembers(id: string) {
    return ApiService.get(`/projects/${id}/members`)
  }

  static async addProjectMember(id: string, userId: string, role: string) {
    return ApiService.post(`/projects/${id}/members`, { userId, role })
  }

  static async removeProjectMember(id: string, userId: string) {
    return ApiService.delete(`/projects/${id}/members/${userId}`)
  }

  static async getProjectStats(id: string) {
    return ApiService.get(`/projects/${id}/stats`)
  }
}

export class TaskService {
  static async getTasks(pagination: PaginationParams, filters?: FilterOptions) {
    // listKey='tasks'：后端统一返回 data.items，这里映射回旧键供旧页面消费
    return PaginatedApiService.getPaginated<Task>('/tasks', pagination, filters, 'tasks')
  }

  static async getTask(id: string) {
    return ApiService.get<Task>(`/tasks/${id}`)
  }

  static async createTask(taskData: Partial<Task>) {
    return ApiService.post<Task>('/tasks', taskData)
  }

  static async updateTask(id: string, taskData: Partial<Task>) {
    return ApiService.put<Task>(`/tasks/${id}`, taskData)
  }

  static async deleteTask(id: string) {
    return ApiService.delete(`/tasks/${id}`)
  }

  static async getProjectTasks(projectId: string, pagination: PaginationParams, filters?: FilterOptions) {
    return PaginatedApiService.getPaginated<Task>(`/projects/${projectId}/tasks`, pagination, filters, 'tasks')
  }

  // ── P2-5 清理：assignTask/completeTask/attachments 系列方法无对应后端路由，已删除 ──
  // assign → PATCH /tasks/:id { assigneeId }；complete → PATCH /tasks/:id { status:'DONE' }

  static async getTaskComments(id: string) {
    return ApiService.get(`/tasks/${id}/comments`)
  }

  static async addTaskComment(id: string, content: string) {
    return ApiService.post(`/tasks/${id}/comments`, { content })
  }
}

// ── P2-5 清理：TeamService / TimeTrackingService / ActivityService 已删除 ──
// 后端无 /teams、/time-entries、/activities 路由；团队职能由组织架构（/organization）承载，
// 活动流由 GET /projects/:id 详情与修订历史（revisions）替代。全局 grep 确认无调用点。

export class NotificationService {
  static async getNotifications(pagination: PaginationParams) {
    return PaginatedApiService.getPaginated<Notification>('/notifications', pagination)
  }

  static async markNotificationRead(id: string) {
    return ApiService.post(`/notifications/${id}/read`, {})
  }

  static async markAllNotificationsRead() {
    return ApiService.post('/notifications/read-all', {})
  }

  static async deleteNotification(id: string) {
    return ApiService.delete(`/notifications/${id}`)
  }
}

export class DashboardService {
  static async getDashboardStats() {
    return ApiService.get<DashboardStats>('/dashboard/stats')
  }

}

export class FileService {
  static async uploadFile(file: File, folder?: string, onProgress?: (progress: number) => void) {
    const formData = new FormData()
    formData.append('file', file)
    if (folder) {
      formData.append('folder', folder)
    }

    try {
      const response = await ApiService.upload('/files/upload', file, onProgress)
      return response
    } catch (error) {
      throw error
    }
  }

  static async deleteFile(fileId: string) {
    return ApiService.delete(`/files/${fileId}`)
  }

  static async getFileUrl(fileId: string) {
    return ApiService.get<{ url: string }>(`/files/${fileId}/url`)
  }
}