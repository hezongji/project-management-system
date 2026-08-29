'use client'

/**
 * 改派阶段负责人弹窗 —— §8.2①「改派负责人」
 * 候选 = 项目成员（tree.members）；落点 PATCH /api/phases/:id { ownerId }。
 */

import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserRoundCog, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ProjectDetailService } from '@/services/project-detail'
import type { PhaseTreeNode, TreeMember } from '@/types/project-tree'
import { cn } from '@/lib/utils'

interface AssignOwnerDialogProps {
  phase: PhaseTreeNode | null
  members: TreeMember[]
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssignOwnerDialog({
  phase,
  members,
  projectId,
  open,
  onOpenChange,
}: AssignOwnerDialogProps) {
  const [ownerId, setOwnerId] = React.useState<string>('')
  const { toast } = useToast()
  const queryClient = useQueryClient()

  React.useEffect(() => {
    if (open && phase) setOwnerId(phase.owner?.id ?? '')
  }, [open, phase])

  const mutation = useMutation({
    mutationFn: (newOwnerId: string) =>
      phase
        ? ProjectDetailService.patchPhase(phase.id, {
            ownerId: newOwnerId === '__none__' ? null : newOwnerId,
          })
        : Promise.reject(),
    onSuccess: () => {
      toast({ description: '阶段负责人已改派' })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
      onOpenChange(false)
    },
    onError: (e: Error) => {
      toast({ title: '改派失败', description: e.message, variant: 'destructive' })
    },
  })

  if (!phase) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRoundCog className="h-4 w-4" />
            改派负责人 —— {phase.code} {phase.name}
          </DialogTitle>
          <DialogDescription>
            候选范围为本项目成员；改派将记入项目动态（ActivityLog）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label>新负责人</Label>
          <Select value={ownerId || undefined} onValueChange={setOwnerId}>
            <SelectTrigger>
              <SelectValue placeholder="选择项目成员（可置空待分配）" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                <span className="text-muted-foreground">（置空：待分配提醒）</span>
              </SelectItem>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.name}
                  <span className="ml-1 text-xs text-muted-foreground">
                    · {m.title ?? m.role}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(ownerId || '__none__')}
            className={cn(mutation.isPending && 'opacity-80')}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            确认改派
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
