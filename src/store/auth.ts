import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { User } from '@/types'

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (user: User) => void
  logout: () => void
  updateUser: (userData: Partial<User>) => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState>()(
  devtools(
    persist(
      (set, get) => ({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        
        login: (user: User) => {
          set({ user, isAuthenticated: true, isLoading: false })
          // 同时保存到 localStorage 以便 AuthProvider 使用
          localStorage.setItem('auth-user', JSON.stringify(user))
        },
        
        logout: () => {
          set({ user: null, isAuthenticated: false, isLoading: false })
          // 清除 localStorage
          localStorage.removeItem('auth-token')
          localStorage.removeItem('auth-user')
        },
        
        updateUser: (userData: Partial<User>) => {
          const currentUser = get().user
          if (currentUser) {
            set({ user: { ...currentUser, ...userData } })
          }
        },
        
        setLoading: (loading: boolean) => {
          set({ isLoading: loading })
        },
      }),
      {
        name: 'auth-storage',
        partialize: (state) => ({
          user: state.user,
          isAuthenticated: state.isAuthenticated,
        }),
      }
    ),
    { name: 'auth-store' }
  )
)