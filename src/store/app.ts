import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { Notification, Activity } from '@/types'

interface AppState {
  notifications: Notification[]
  activities: Activity[]
  unreadCount: number
  sidebarOpen: boolean
  mobileMenuOpen: boolean
  
  setNotifications: (notifications: Notification[]) => void
  addNotification: (notification: Notification) => void
  markNotificationRead: (notificationId: string) => void
  markAllNotificationsRead: () => void
  deleteNotification: (notificationId: string) => void
  
  setActivities: (activities: Activity[]) => void
  addActivity: (activity: Activity) => void
  
  setSidebarOpen: (open: boolean) => void
  setMobileMenuOpen: (open: boolean) => void
  
  clearAll: () => void
}

export const useAppStore = create<AppState>()(
  devtools(
    (set, get) => ({
      notifications: [],
      activities: [],
      unreadCount: 0,
      sidebarOpen: true,
      mobileMenuOpen: false,
      
      setNotifications: (notifications: Notification[]) => {
        const unreadCount = notifications.filter((n) => !n.isRead).length
        set({ notifications, unreadCount })
      },
      
      addNotification: (notification: Notification) => {
        set((state) => {
          const newNotifications = [notification, ...state.notifications]
          const unreadCount = newNotifications.filter((n) => !n.isRead).length
          return {
            notifications: newNotifications,
            unreadCount,
          }
        })
      },
      
      markNotificationRead: (notificationId: string) => {
        set((state) => {
          const updatedNotifications = state.notifications.map((notification) =>
            notification.id === notificationId
              ? { ...notification, isRead: true }
              : notification
          )
          const unreadCount = updatedNotifications.filter((n) => !n.isRead).length
          return {
            notifications: updatedNotifications,
            unreadCount,
          }
        })
      },
      
      markAllNotificationsRead: () => {
        set((state) => ({
          notifications: state.notifications.map((notification) => ({
            ...notification,
            isRead: true,
          })),
          unreadCount: 0,
        }))
      },
      
      deleteNotification: (notificationId: string) => {
        set((state) => {
          const updatedNotifications = state.notifications.filter(
            (notification) => notification.id !== notificationId
          )
          const unreadCount = updatedNotifications.filter((n) => !n.isRead).length
          return {
            notifications: updatedNotifications,
            unreadCount,
          }
        })
      },
      
      setActivities: (activities: Activity[]) => set({ activities }),
      
      addActivity: (activity: Activity) => {
        set((state) => ({
          activities: [activity, ...state.activities].slice(0, 50),
        }))
      },
      
      setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),
      
      setMobileMenuOpen: (open: boolean) => set({ mobileMenuOpen: open }),
      
      clearAll: () => set({
        notifications: [],
        activities: [],
        unreadCount: 0,
      }),
    }),
    { name: 'app-store' }
  )
)