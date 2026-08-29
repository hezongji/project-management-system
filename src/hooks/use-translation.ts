'use client'

import { messages } from '@/locales/zh-CN'

export function useTranslation() {
  const t = (key: string) => {
    const keys = key.split('.')
    let value: any = messages['zh-CN']
    
    for (const k of keys) {
      value = value?.[k]
    }
    
    return value || key
  }

  return { t }
}