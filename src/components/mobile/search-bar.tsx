'use client'

/**
 * MobileSearchBar —— 移动端搜索输入（样式取自 im-mobile/conversation-list 搜索框）。
 */

import { Search } from 'lucide-react'

export function MobileSearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex h-11 items-center gap-2 rounded-lg bg-muted px-3">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '搜索'}
        className="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
