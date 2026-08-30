'use client'

import { useEffect, useState } from 'react'

/** 移动端判定（<1024px）。SSR 首帧 false（桌面态），挂载后修正，避免水合不匹配。 */
export function useIsMobile(breakpoint = 1024): boolean {
  const [m, setM] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [breakpoint])
  return m
}
