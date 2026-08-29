import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { Project, Task, FilterOptions, PaginationParams } from '@/types'

interface ProjectState {
  projects: Project[]
  currentProject: Project | null
  isLoading: boolean
  filters: FilterOptions
  pagination: PaginationParams
  
  setProjects: (projects: Project[]) => void
  setCurrentProject: (project: Project | null) => void
  addProject: (project: Project) => void
  updateProject: (projectId: string, updates: Partial<Project>) => void
  deleteProject: (projectId: string) => void
  setLoading: (loading: boolean) => void
  setFilters: (filters: FilterOptions) => void
  setPagination: (pagination: PaginationParams) => void
  addTask: (task: Task) => void
  updateTask: (taskId: string, updates: Partial<Task>) => void
  deleteTask: (taskId: string) => void
}

export const useProjectStore = create<ProjectState>()(
  devtools(
    (set, get) => ({
      projects: [],
      currentProject: null,
      isLoading: false,
      filters: {},
      pagination: {
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
      
      setProjects: (projects: Project[]) => set({ projects }),
      
      setCurrentProject: (project: Project | null) => set({ currentProject: project }),
      
      addProject: (project: Project) => {
        set((state) => ({
          projects: [project, ...state.projects],
        }))
      },
      
      updateProject: (projectId: string, updates: Partial<Project>) => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId ? { ...project, ...updates } : project
          ),
          currentProject:
            state.currentProject?.id === projectId
              ? { ...state.currentProject, ...updates }
              : state.currentProject,
        }))
      },
      
      deleteProject: (projectId: string) => {
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== projectId),
          currentProject:
            state.currentProject?.id === projectId ? null : state.currentProject,
        }))
      },
      
      setLoading: (loading: boolean) => set({ isLoading: loading }),
      
      setFilters: (filters: FilterOptions) => set({ filters }),
      
      setPagination: (pagination: PaginationParams) => set({ pagination }),
      
      addTask: (task: Task) => {
        set((state) => {
          const updatedProjects = state.projects.map((project) => {
            if (project.id === task.projectId) {
              return {
                ...project,
                tasks: [...(project.tasks ?? []), task],
              }
            }
            return project
          })
          
          const updatedCurrentProject = state.currentProject?.id === task.projectId
            ? {
                ...state.currentProject,
                tasks: [...(state.currentProject.tasks ?? []), task],
              }
            : state.currentProject
          
          return {
            projects: updatedProjects,
            currentProject: updatedCurrentProject,
          }
        })
      },
      
      updateTask: (taskId: string, updates: Partial<Task>) => {
        set((state) => {
          const updateTaskInProject = (project: Project): Project => ({
            ...project,
            tasks: (project.tasks ?? []).map((task) =>
              task.id === taskId ? { ...task, ...updates } : task
            ),
          })
          
          return {
            projects: state.projects.map(updateTaskInProject),
            currentProject: state.currentProject
              ? updateTaskInProject(state.currentProject)
              : null,
          }
        })
      },
      
      deleteTask: (taskId: string) => {
        set((state) => {
          const removeTaskFromProject = (project: Project): Project => ({
            ...project,
            tasks: (project.tasks ?? []).filter((task) => task.id !== taskId),
          })
          
          return {
            projects: state.projects.map(removeTaskFromProject),
            currentProject: state.currentProject
              ? removeTaskFromProject(state.currentProject)
              : null,
          }
        })
      },
    }),
    { name: 'project-store' }
  )
)