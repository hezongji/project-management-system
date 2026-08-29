'use client'

import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Construction, type LucideIcon } from 'lucide-react'

interface PlaceholderPageProps {
  icon: LucideIcon
  title: string
  description: string
  stage: string // 交付阶段标识，如 P0-4 / P2 / P3 / P4 / P5
}

/** 通用占位页：导航先行，功能由后续阶段任务交付 */
export function PlaceholderPage({ icon: Icon, title, description, stage }: PlaceholderPageProps) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-lg text-center">
        <CardHeader>
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Icon className="h-7 w-7 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-center gap-2">
            <CardTitle className="text-xl">{title}</CardTitle>
            <Badge variant="secondary">{stage}</Badge>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Construction className="h-4 w-4" />
            本模块由后续阶段任务交付，当前导航结构已就位
          </p>
          <Link href="/">
            <Button variant="outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回工作台
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
