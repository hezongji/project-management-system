'use client'

/**
 * 跳过阶段弹窗 —— §8.2①「跳过(权限+备注弹窗)」、§7.5 POST /phases/:id/skip
 * skippedNote 必填（前端校验 + 后端 zod 双保险）。
 */

import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SkipForward, Loader2 } from 'lucide-react'

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
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { ProjectDetailService } from '@/services/project-detail'
import type { PhaseTreeNode } from '@/types/project-tree'

interface SkipPhaseDialogProps {
  phase: PhaseTreeNode | null
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SkipPhaseDialog({ phase, projectId, open, onOpenChange }: SkipPhaseDialogProps) {
  const [note, setNote] = React.useState('')
  const { toast } = useToast()
  const queryClient = useQueryClient()

  React.useEffect(() => {
    if (open) setNote('')
  }, [open])

  const mutation = useMutation({
    mutationFn: (skippedNote: string) =>
      phase ? ProjectDetailService.skipPhase(phase.id, skippedNote) : Promise.reject(),
    onSuccess: (res) => {
      toast({ description: (res as { message?: string }).message ?? '阶段已跳过' })
      queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tree'] })
      onOpenChange(false)
    },
    onError: (e: Error) => {
      toast({ title: '跳过失败', description: e.message, variant: 'destructive' })
    },
  })

  if (!phase) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SkipForward className="h-4 w-4 text-yellow-500" />
            跳过阶段 {phase.code} {phase.name}
          </DialogTitle>
          <DialogDescription>
            跳过原因必填，将记入项目动态并留痕（ActivityLog）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="skip-note">
            跳过原因 <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="skip-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例：客户自备该阶段交付物，经项目经理确认跳过"
            rows={3}
            maxLength={500}
          />
          <p className="text-xs text-muted-foreground">{note.length}/500</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending || note.trim().length === 0}
            onClick={() => mutation.mutate(note.trim())}
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            确认跳过
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
