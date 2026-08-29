'use client'

/**
 * 进度环（SVG）—— §8.2① 阶段卡「进度环」
 * size 直径 px；stroke 环宽；完成度满时环色变绿。
 */

import { cn } from '@/lib/utils'

interface ProgressRingProps {
  value: number
  size?: number
  stroke?: number
  className?: string
}

export function ProgressRing({ value, size = 44, stroke = 4, className }: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - clamped / 100)
  const full = clamped >= 100

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={full ? 'stroke-green-500' : 'stroke-blue-500'}
          style={{ transition: 'stroke-dashoffset 0.4s ease' }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-muted-foreground"
        style={{ fontSize: Math.max(9, size / 4) }}
      >
        {clamped}
      </span>
    </div>
  )
}
