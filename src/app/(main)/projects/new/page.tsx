'use client'

/**
 * /projects/new 新建项目向导（4 步）—— 依据《开发文档-项目管理系统重构》§8.2⑦、§7.4
 *
 * ① 基本信息：code 可留空自动生成（DEMO+签约年后两位+3位流水）、客户从外部主体 CUSTOMER
 *    拉取、金额/合同号/日期；校验：必填/金额格式/日期先后（signedAt≤plannedStart<plannedEnd）
 * ② 模板选择：默认20步 / 精简10步 / 已有自定义模板卡片 + 自定义编辑器（拖拽增删+岗位选择）；
 *    自定义流程需先「存为新模板」（§7.3 模板 API 仅 ADMIN，非 ADMIN 向导内只读提示，见报告）
 * ③ 成员与负责人：组织树选人（角色/头衔可编辑）+ 各阶段岗位自动匹配负责人（与 phase-engine
 *    同款 createdAt 升序取第一人）→ 可手动改派（提交为 stageOverrides[order].ownerId）
 * ④ 预览确认：阶段数/负责人分配情况/待分配提醒 清单摘要 → POST /api/projects → 跳 /projects/:id
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileStack,
  Loader2,
  Save,
  Search,
  ShieldAlert,
  UserCheck,
  Users,
  Plus,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AiAutofillButton } from '@/components/ai/ai-autofill-button'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { ApiService, ApiError } from '@/services/api'
import { OrgService } from '@/services/org'
import type { DeptNode, DeptMemberBrief } from '@/lib/org-tree'
import {
  ProcessTemplateService,
  type EditableStage,
  toEditableStages,
  toApiStages,
} from '@/services/template'
import { StageEditor } from '@/components/templates/stage-editor'
import {
  WIZARD_RESULT_KEY,
  type CreateResultSummary,
} from '@/lib/wizard-handoff'

// ───────────────────────────── 类型 ─────────────────────────────

interface BasicForm {
  code: string
  name: string
  customerId: string
  contractNo: string
  location: string
  amount: string
  signedAt: string
  plannedStart: string
  plannedEnd: string
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  description: string
}

interface MemberRow {
  userId: string
  role: 'MANAGER' | 'MEMBER' | 'VIEWER'
  title: string
  /** 交付物（2026-08-21）：该成员需提交的工作文件清单 */
  deliverables: string[]
}

const BASIC_INIT: BasicForm = {
  code: '',
  name: '',
  customerId: '',
  contractNo: '',
  location: '',
  amount: '',
  signedAt: '',
  plannedStart: '',
  plannedEnd: '',
  priority: 'MEDIUM',
  description: '',
}

const STEPS = [
  { n: 1, label: '基本信息' },
  { n: 2, label: '模板选择' },
  { n: 3, label: '成员与负责人' },
  { n: 4, label: '预览确认' },
]

const PRIORITY_LABEL: Record<BasicForm['priority'], string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
}

const AUTO = '__auto__'

// ───────────────────────────── 主组件 ─────────────────────────────

export default function NewProjectWizard() {
  const router = useRouter()
  const { toast } = useToast()
  const me = useAuthStore((s) => s.user)
  const isAdmin = me?.role === 'ADMIN'

  const [step, setStep] = React.useState(1)
  const [basic, setBasic] = React.useState<BasicForm>(BASIC_INIT)
  const [basicErrors, setBasicErrors] = React.useState<Record<string, string>>({})

  // 步骤②：模板
  const [templateMode, setTemplateMode] = React.useState<'existing' | 'custom'>('existing')
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>('')
  const [customBaseId, setCustomBaseId] = React.useState<string>('')
  const [customStages, setCustomStages] = React.useState<EditableStage[]>([])
  const [customSavedId, setCustomSavedId] = React.useState<string | null>(null)
  const [customSavedName, setCustomSavedName] = React.useState<string>('')
  const [customName, setCustomName] = React.useState('')
  const [savingTemplate, setSavingTemplate] = React.useState(false)

  // 步骤③：成员与阶段负责人
  const [selectedUserIds, setSelectedUserIds] = React.useState<Set<string>>(new Set())
  const [memberRows, setMemberRows] = React.useState<MemberRow[]>([])
  // 步骤③：通栏表格筛选（2026-08-21：成员分配改表格式）
  const [memberSearch, setMemberSearch] = React.useState('')
  const [deptFilter, setDeptFilter] = React.useState('')
  const [ownerOverrides, setOwnerOverrides] = React.useState<Record<number, string>>({})

  const [submitting, setSubmitting] = React.useState(false)

  // ── 数据 ──
  const { data: templates, isLoading: templatesLoading } = useQuery({
    queryKey: ['process-templates'],
    queryFn: ProcessTemplateService.list,
  })

  // 自动选中默认模板（避免用户到第 2 步必须手动点模板卡片才能「下一步」）
  const autoSelectedTemplate = React.useRef(false)
  React.useEffect(() => {
    if (templates && templates.length > 0 && !autoSelectedTemplate.current) {
      const def = templates.find((t) => t.isDefault) ?? templates[0]
      if (def) {
        setTemplateMode('existing')
        setSelectedTemplateId(def.id)
        autoSelectedTemplate.current = true
      }
    }
  }, [templates])
  const { data: jobTitles } = useQuery({
    queryKey: ['job-titles'],
    queryFn: OrgService.getJobTitles,
  })
  const { data: customersData } = useQuery({
    queryKey: ['external-orgs', 'CUSTOMER'],
    queryFn: () => OrgService.getExternalOrgs({ type: 'CUSTOMER', limit: 100 }),
  })
  const customers = (customersData?.items ?? []).filter((c) => c.isActive)
  const queryClient = useQueryClient()
  const [newCustomerOpen, setNewCustomerOpen] = React.useState(false)
  const [newCustomer, setNewCustomer] = React.useState({ name: '', phone: '', address: '', remark: '' })
  const [savingCustomer, setSavingCustomer] = React.useState(false)

  const submitNewCustomer = async () => {
    if (!newCustomer.name.trim()) {
      toast({ title: '请填写主体名称', variant: 'destructive' })
      return
    }
    setSavingCustomer(true)
    try {
      const res = await ApiService.post<{ id: string }>('/external-orgs', {
        name: newCustomer.name.trim(),
        type: 'CUSTOMER',
        phone: newCustomer.phone.trim() || null,
        address: newCustomer.address.trim() || null,
        remark: newCustomer.remark.trim() || null,
      })
      await queryClient.invalidateQueries({ queryKey: ['external-orgs', 'CUSTOMER'] })
      setBasic((prev) => ({ ...prev, customerId: res.data?.id ?? '' }))
      setNewCustomer({ name: '', phone: '', address: '', remark: '' })
      setNewCustomerOpen(false)
      toast({ title: '客户主体已创建' })
    } catch (e) {
      toast({ title: e instanceof ApiError ? e.message : '创建失败', variant: 'destructive' })
    } finally {
      setSavingCustomer(false)
    }
  }
  const { data: deptTree } = useQuery({ queryKey: ['departments'], queryFn: OrgService.getDepartments })

  // 全员列表（含 createdAt，用于与 phase-engine 同款的岗位自动匹配预演）
  const allUsers = React.useMemo(() => {
    const out: Array<DeptMemberBrief & { deptPath: string }> = []
    const walk = (nodes: DeptNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix} / ${n.name}` : n.name
        for (const m of n.members) out.push({ ...m, deptPath: path })
        walk(n.children, path)
      }
    }
    if (deptTree) walk(deptTree as DeptNode[], '')
    return out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [deptTree])
  const userById = React.useMemo(() => new Map(allUsers.map((u) => [u.id, u])), [allUsers])

  // 步骤③：通栏表格数据（部门筛选 + 搜索）
  const deptNames = React.useMemo(
    () => Array.from(new Set(allUsers.map((u) => u.deptPath.split(' / ')[0]))).sort(),
    [allUsers],
  )
  const filteredUsers = React.useMemo(() => {
    const q = memberSearch.trim().toLowerCase()
    return allUsers.filter((u) => {
      if (deptFilter && !u.deptPath.startsWith(deptFilter)) return false
      if (!q) return true
      return (
        u.name.toLowerCase().includes(q) ||
        u.deptPath.toLowerCase().includes(q) ||
        (u.jobTitle ?? '').toLowerCase().includes(q)
      )
    })
  }, [allUsers, deptFilter, memberSearch])

  /** 岗位 → 自动匹配负责人（createdAt 升序第一人，与 phase-engine.matchOwnerForJobTitle 一致） */
  const autoOwnerByJobTitle = React.useMemo(() => {
    const map = new Map<string, DeptMemberBrief>()
    for (const u of allUsers) {
      if (u.jobTitle && !map.has(u.jobTitle)) map.set(u.jobTitle, u)
    }
    return map
  }, [allUsers])

  const activeTemplate = templates?.find((t) => t.id === selectedTemplateId) ?? null
  const customBase = templates?.find((t) => t.id === customBaseId) ?? null

  /** 提交将生效的阶段列表（自定义模式用本地编辑值；否则用所选模板） */
  const effectiveStages: EditableStage[] =
    templateMode === 'custom'
      ? customStages
      : activeTemplate
        ? toEditableStages(activeTemplate)
        : []

  /** 阶段行 → 展示/提交用的负责人（改派优先，自动匹配兜底） */
  const stageOwners = React.useMemo(
    () =>
      effectiveStages.map((s, i) => {
        const order = i + 1
        const override = ownerOverrides[order]
        const auto = s.ownerJobTitle ? autoOwnerByJobTitle.get(s.ownerJobTitle) : undefined
        const owner = override ? userById.get(override) : auto
        return {
          order,
          stage: s,
          override: override ?? null,
          autoName: auto?.name ?? null,
          owner: owner ?? null,
          autoMatched: !override && !!auto,
          pending: !owner,
        }
      }),
    [effectiveStages, ownerOverrides, autoOwnerByJobTitle, userById],
  )

  // ── 步骤① 校验 ──
  function validateBasic(): boolean {
    const errs: Record<string, string> = {}
    if (!basic.name.trim()) errs.name = '项目名称不能为空'
    if (!basic.customerId) errs.customerId = '请选择客户主体'
    if (basic.code.trim() && !/^DEMO\d{2}\d{3,}$/.test(basic.code.trim()))
      errs.code = '编号格式：DEMO+签约年后两位+流水（如 DEMO26001），留空自动生成'
    if (basic.amount.trim()) {
      if (!/^\d{1,12}(\.\d{1,2})?$/.test(basic.amount.trim()))
        errs.amount = '金额格式：数字，最多两位小数'
    }
    const { signedAt, plannedStart, plannedEnd } = basic
    if (plannedStart && plannedEnd && plannedStart >= plannedEnd)
      errs.plannedEnd = '计划结束必须晚于计划开始（plannedStart < plannedEnd）'
    if (signedAt && plannedStart && signedAt > plannedStart)
      errs.plannedStart = '签约日期不能晚于计划开始'
    if (signedAt && plannedEnd && signedAt > plannedEnd) errs.plannedEnd = '签约日期不能晚于计划结束'
    setBasicErrors(errs)
    return Object.keys(errs).length === 0
  }

  // ── 步骤②：自定义模板 ──
  function pickCustom() {
    setTemplateMode('custom')
    if (customStages.length === 0) {
      const base = templates?.find((t) => t.isDefault) ?? templates?.[0] ?? null
      if (base) {
        setCustomBaseId(base.id)
        setCustomStages(toEditableStages(base))
        setCustomName(`${base.name}（自定义）`)
      }
    }
  }

  function switchCustomBase(id: string) {
    setCustomBaseId(id)
    const base = templates?.find((t) => t.id === id)
    if (base) {
      setCustomStages(toEditableStages(base))
      setCustomName((prev) => (prev ? prev : `${base.name}（自定义）`))
    }
  }

  /** 本地编辑后已保存模板失效，需重新保存 */
  function markCustomDirty(stages: EditableStage[]) {
    setCustomStages(stages)
    setCustomSavedId(null)
    setCustomSavedName('')
  }

  async function saveCustomTemplate() {
    if (!customName.trim()) {
      toast({ title: '请填写新模板名称', variant: 'destructive' })
      return
    }
    const unnamed = customStages.findIndex((s) => !s.name.trim())
    if (unnamed >= 0) {
      toast({ title: `第 ${unnamed + 1} 个阶段名称不能为空`, variant: 'destructive' })
      return
    }
    setSavingTemplate(true)
    try {
      const t = await ProcessTemplateService.create({
        name: customName.trim(),
        stages: toApiStages(customStages),
      })
      setCustomSavedId(t.id)
      setCustomSavedName(t.name)
      toast({ description: `已保存为新模板「${t.name}」（${t.stages.length} 阶段），将用于本项目` })
    } catch (e) {
      toast({
        title: '保存模板失败',
        description: e instanceof ApiError ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSavingTemplate(false)
    }
  }

  // ── 步骤③：成员 ──
  function toggleMember(u: DeptMemberBrief) {
    if (selectedUserIds.has(u.id)) {
      setSelectedUserIds((prev) => {
        const next = new Set(prev)
        next.delete(u.id)
        return next
      })
      setMemberRows((rows) => rows.filter((r) => r.userId !== u.id))
    } else {
      setSelectedUserIds((prev) => new Set(prev).add(u.id))
      setMemberRows((rows) => [
        ...rows,
        { userId: u.id, role: 'MEMBER', title: u.jobTitle ?? '', deliverables: [] },
      ])
    }
  }

  function updateMemberRow(userId: string, patch: Partial<MemberRow>) {
    setMemberRows((rows) => rows.map((r) => (r.userId === userId ? { ...r, ...patch } : r)))
  }

  function setOwner(order: number, value: string) {
    setOwnerOverrides((prev) => {
      const next = { ...prev }
      if (value === AUTO || value === '') delete next[order]
      else next[order] = value
      return next
    })
  }

  // ── 步骤切换 ──
  function canNext(): string | null {
    if (step === 1) return validateBasic() ? null : '请先修正基本信息中的错误'
    if (step === 2) {
      if (templateMode === 'existing') {
        if (!selectedTemplateId) return '请选择一个流程模板'
        return null
      }
      if (!customSavedId) return '自定义流程需先「存为新模板」后才能用于创建项目'
      return null
    }
    return null
  }

  function next() {
    const err = canNext()
    if (err) {
      toast({ title: err, variant: 'destructive' })
      return
    }
    setStep((s) => Math.min(4, s + 1))
  }

  // ── 提交 ──
  async function submit() {
    setSubmitting(true)
    try {
      const templateId = templateMode === 'custom' ? customSavedId! : selectedTemplateId
      const res = await ApiService.post<{
        project: { id: string; code: string; name: string }
        phaseCount: number
        catalogCount: number
        requirementCount: number
        memberCount: number
        pendingAssignment: { order: number; phaseCode: string; name: string; ownerJobTitle: string }[]
      }>('/projects', {
        ...(basic.code.trim() ? { code: basic.code.trim() } : {}),
        name: basic.name.trim(),
        customerId: basic.customerId || undefined,
        contractNo: basic.contractNo.trim() || null,
        location: basic.location.trim() || null,
        amount: basic.amount.trim() ? Number(basic.amount.trim()) : undefined,
        signedAt: basic.signedAt || null,
        plannedStart: basic.plannedStart || null,
        plannedEnd: basic.plannedEnd || null,
        priority: basic.priority,
        description: basic.description.trim() || undefined,
        templateId,
        stageOverrides: Object.entries(ownerOverrides).map(([order, ownerId]) => ({
          order: Number(order),
          ownerId,
        })),
        members: memberRows.map((r) => ({
          userId: r.userId,
          role: r.role,
          ...(r.title.trim() ? { title: r.title.trim() } : {}),
          // 交付物：该成员需提交的工作文件（去空去重）
          ...(r.deliverables.length
            ? { deliverables: Array.from(new Set(r.deliverables.map((d) => d.trim()).filter(Boolean))) }
            : {}),
        })),
      })

      const d = res.data!
      const summary: CreateResultSummary = {
        projectId: d.project.id,
        code: d.project.code,
        name: d.project.name,
        templateName:
          templateMode === 'custom'
            ? customSavedName || '自定义模板'
            : (activeTemplate?.name ?? ''),
        phaseCount: d.phaseCount,
        memberCount: d.memberCount,
        requirementCount: d.requirementCount,
        pendingAssignment: d.pendingAssignment.map((p) => ({
          phaseCode: p.phaseCode,
          name: p.name,
          ownerJobTitle: p.ownerJobTitle,
        })),
      }
      sessionStorage.setItem(WIZARD_RESULT_KEY, JSON.stringify(summary))
      toast({
        title: `项目 ${d.project.code} 创建成功`,
        description:
          d.pendingAssignment.length > 0
            ? `已实例化 ${d.phaseCount} 个阶段；${d.pendingAssignment.length} 个阶段待分配负责人`
            : `已实例化 ${d.phaseCount} 个阶段`,
      })
      router.push(`/projects/${d.project.id}`)
    } catch (e) {
      toast({
        title: '创建失败',
        description: e instanceof ApiError ? e.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const pendingCount = stageOwners.filter((s) => s.pending).length
  const assignedCount = stageOwners.length - pendingCount

  // 创建权限拦截（2026-08-21）：仅 ADMIN / 项目经理可创建项目，其余显示无权限
  const canCreate = isAdmin || me?.role === 'PROJECT_MANAGER'
  if (!canCreate) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">无权限访问</h1>
          <p className="text-sm text-muted-foreground">
            仅管理员（ADMIN）和项目经理（PROJECT_MANAGER）可以创建项目。如需创建，请联系管理员为你提升角色。
          </p>
        </CardContent>
      </Card>
    )
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  return (
    <div className="w-full space-y-6 p-4 md:p-6">
      {/* 头部 + 步骤条 */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/projects')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">新建项目</h1>
          <p className="text-sm text-muted-foreground">
            四步创建：基本信息 → 模板选择 → 成员与负责人 → 预览确认
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.n}>
            <div
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm',
                step === s.n
                  ? 'bg-primary text-primary-foreground'
                  : step > s.n
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full border text-xs',
                  step > s.n ? 'border-primary' : 'border-current',
                )}
              >
                {step > s.n ? <Check className="h-3 w-3" /> : s.n}
              </span>
              {s.label}
            </div>
            {i < STEPS.length - 1 ? <div className="h-px flex-1 bg-border" /> : null}
          </React.Fragment>
        ))}
      </div>

      {/* 步骤①：基本信息 */}
      {step === 1 ? (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>基本信息</CardTitle>
                <CardDescription>编号留空将按「DEMO+签约年后两位+3位流水」自动生成</CardDescription>
              </div>
              <AiAutofillButton
                context="新建项目管理系统的项目，字段：name(项目名称),description(项目描述),code(可选)"
                fields={['name', 'description']}
                labels={{ name: '项目名称', description: '项目描述' }}
                onApply={(s) =>
                  setBasic((b) => ({
                    ...b,
                    ...(s.name?.trim() ? { name: s.name.trim() } : {}),
                    ...(s.description?.trim() ? { description: s.description.trim() } : {}),
                  }))
                }
              />
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="wz-name">项目名称 *</Label>
              <Input
                id="wz-name"
                value={basic.name}
                onChange={(e) => setBasic({ ...basic, name: e.target.value })}
                placeholder="如：XX食品三期产线电气总包"
                className={basicErrors.name ? 'border-red-500' : ''}
              />
              {basicErrors.name ? <p className="text-xs text-red-500">{basicErrors.name}</p> : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-code">项目编号</Label>
              <Input
                id="wz-code"
                value={basic.code}
                onChange={(e) => setBasic({ ...basic, code: e.target.value })}
                placeholder="留空自动生成（DEMO26xxx）"
                className={basicErrors.code ? 'border-red-500' : ''}
              />
              {basicErrors.code ? <p className="text-xs text-red-500">{basicErrors.code}</p> : null}
            </div>

            <div className="space-y-2">
              <Label>客户主体 *</Label>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <Select
                    value={basic.customerId}
                    onValueChange={(v) => setBasic({ ...basic, customerId: v })}
                  >
                    <SelectTrigger className={basicErrors.customerId ? 'border-red-500' : ''}>
                      <SelectValue placeholder="选择客户（外部主体 CUSTOMER）" />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="outline" onClick={() => setNewCustomerOpen(true)}>
                  <Plus className="mr-1 h-4 w-4" /> 新建客户
                </Button>
              </div>
              {basicErrors.customerId ? (
                <p className="text-xs text-red-500">{basicErrors.customerId}</p>
              ) : null}
            </div>

            <Dialog open={newCustomerOpen} onOpenChange={setNewCustomerOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>新建客户主体</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>主体名称 *</Label>
                    <Input value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} placeholder="客户公司全称" />
                  </div>
                  <div className="space-y-1">
                    <Label>联系电话</Label>
                    <Input value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} placeholder="可选" />
                  </div>
                  <div className="space-y-1">
                    <Label>地址</Label>
                    <Input value={newCustomer.address} onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })} placeholder="可选" />
                  </div>
                  <div className="space-y-1">
                    <Label>备注</Label>
                    <Input value={newCustomer.remark} onChange={(e) => setNewCustomer({ ...newCustomer, remark: e.target.value })} placeholder="可选" />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setNewCustomerOpen(false)}>取消</Button>
                  <Button type="button" onClick={submitNewCustomer} disabled={savingCustomer}>
                    {savingCustomer ? '创建中…' : '创建'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <div className="space-y-2">
              <Label htmlFor="wz-contract">合同编号</Label>
              <Input
                id="wz-contract"
                value={basic.contractNo}
                onChange={(e) => setBasic({ ...basic, contractNo: e.target.value })}
                placeholder="如：SHYYHT0905"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-amount">合同金额（元）</Label>
              <Input
                id="wz-amount"
                inputMode="decimal"
                value={basic.amount}
                onChange={(e) => setBasic({ ...basic, amount: e.target.value })}
                placeholder="如：1250000 或 1250000.00"
                className={basicErrors.amount ? 'border-red-500' : ''}
              />
              {basicErrors.amount ? (
                <p className="text-xs text-red-500">{basicErrors.amount}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-location">施工地/项目地点</Label>
              <Input
                id="wz-location"
                value={basic.location}
                onChange={(e) => setBasic({ ...basic, location: e.target.value })}
                placeholder="如：河南三期"
              />
            </div>

            <div className="space-y-2">
              <Label>优先级</Label>
              <Select
                value={basic.priority}
                onValueChange={(v) => setBasic({ ...basic, priority: v as BasicForm['priority'] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRIORITY_LABEL) as BasicForm['priority'][]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-signed">签约日期</Label>
              <Input
                id="wz-signed"
                type="date"
                value={basic.signedAt}
                onChange={(e) => setBasic({ ...basic, signedAt: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-ps">计划开始</Label>
              <Input
                id="wz-ps"
                type="date"
                value={basic.plannedStart}
                onChange={(e) => setBasic({ ...basic, plannedStart: e.target.value })}
                className={basicErrors.plannedStart ? 'border-red-500' : ''}
              />
              {basicErrors.plannedStart ? (
                <p className="text-xs text-red-500">{basicErrors.plannedStart}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wz-pe">计划结束</Label>
              <Input
                id="wz-pe"
                type="date"
                value={basic.plannedEnd}
                onChange={(e) => setBasic({ ...basic, plannedEnd: e.target.value })}
                className={basicErrors.plannedEnd ? 'border-red-500' : ''}
              />
              {basicErrors.plannedEnd ? (
                <p className="text-xs text-red-500">{basicErrors.plannedEnd}</p>
              ) : null}
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="wz-desc">项目描述</Label>
              <Textarea
                id="wz-desc"
                rows={3}
                value={basic.description}
                onChange={(e) => setBasic({ ...basic, description: e.target.value })}
                placeholder="选填"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 步骤②：模板选择 */}
      {step === 2 ? (
        <div className="space-y-4">
          {templatesLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载模板…
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(templates ?? []).map((t) => {
                const selected = templateMode === 'existing' && selectedTemplateId === t.id
                return (
                  <Card
                    key={t.id}
                    className={cn(
                      'cursor-pointer transition-colors hover:border-primary/60',
                      selected && 'border-primary ring-2 ring-primary/30',
                    )}
                    onClick={() => {
                      setTemplateMode('existing')
                      setSelectedTemplateId(t.id)
                    }}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <FileStack className="h-4 w-4 text-muted-foreground" />
                          <span className="truncate">{t.name}</span>
                        </CardTitle>
                        {selected ? <Badge>已选</Badge> : null}
                      </div>
                      <CardDescription>
                        {t.isDefault ? '默认模板 · ' : ''}
                        {t.stages.length} 阶段 · 被引用 {t._count?.projects ?? 0} 个项目
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="line-clamp-3 text-xs text-muted-foreground">
                        {t.stages.map((s) => s.name).join(' → ')}
                      </p>
                    </CardContent>
                  </Card>
                )
              })}

              {/* 自定义编辑器卡片 */}
              <Card
                className={cn(
                  'cursor-pointer border-dashed transition-colors hover:border-primary/60',
                  templateMode === 'custom' && 'border-primary ring-2 ring-primary/30',
                )}
                onClick={pickCustom}
              >
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Copy className="h-4 w-4 text-muted-foreground" /> 自定义流程
                  </CardTitle>
                  <CardDescription>以现有模板为底稿裁剪阶段、调整顺序与岗位</CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  需先保存为新模板再用于创建项目（模板管理仅 ADMIN）
                </CardContent>
              </Card>
            </div>
          )}

          {templateMode === 'custom' ? (
            <Card>
              <CardHeader>
                <CardTitle>自定义编辑器</CardTitle>
                <CardDescription>
                  拖拽排序 / 增删阶段 / 岗位下拉；交付物清单随阶段原样保留；完整模板管理见
                  <a className="mx-1 underline" href="/process-templates">
                    流程模板
                  </a>
                  页
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">底稿模板</Label>
                    <Select value={customBaseId} onValueChange={switchCustomBase}>
                      <SelectTrigger className="h-8 w-[220px]">
                        <SelectValue placeholder="选择底稿" />
                      </SelectTrigger>
                      <SelectContent>
                        {(templates ?? []).map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}（{t.stages.length} 阶段）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">新模板名称</Label>
                    <Input
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder="如：小型改造项目流程"
                      className="h-8"
                      disabled={!isAdmin}
                    />
                  </div>
                  {isAdmin ? (
                    <Button size="sm" onClick={saveCustomTemplate} disabled={savingTemplate}>
                      {savingTemplate ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-1 h-4 w-4" />
                      )}
                      存为新模板并使用
                    </Button>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      仅 ADMIN 可保存模板
                    </Badge>
                  )}
                </div>

                {customSavedId ? (
                  <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                    ✓ 已保存为模板「{customSavedName}」，创建项目将使用该模板
                  </div>
                ) : isAdmin ? (
                  <p className="text-sm text-muted-foreground">
                    修改完成后请点击「存为新模板并使用」，再进入下一步
                  </p>
                ) : (
                  <div className="rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                    自定义阶段结构需保存为模板后才能用于建项；模板保存仅管理员可操作。请选择上方现有模板，
                    或联系管理员在「流程模板」页维护自定义模板。
                  </div>
                )}

                <StageEditor
                  stages={customStages}
                  onStagesChange={markCustomDirty}
                  jobTitles={(jobTitles ?? []).map((t) => t.name)}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* 步骤③：成员与负责人（通栏表格式，2026-08-21 改版） */}
      {step === 3 ? (
        <div className="space-y-4">
          {/* 筛选条：搜索 + 部门（替代原左侧组织树） */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <div className="relative min-w-[200px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="搜索姓名 / 部门 / 岗位..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  className="h-9 pl-8"
                />
              </div>
              <Select value={deptFilter || 'all'} onValueChange={(v) => setDeptFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="h-9 w-[180px]">
                  <SelectValue placeholder="全部部门" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部部门</SelectItem>
                  {deptNames.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="secondary" className="h-7 px-2.5">
                已选 {memberRows.length + 1} 人（含您）
              </Badge>
            </CardContent>
          </Card>

          {/* 员工列表（通栏表格，点击行加入/移除） */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" /> 员工列表（点击行选择成员）
              </CardTitle>
              <CardDescription>
                您本人将作为项目负责人（OWNER）自动加入，无需勾选；点员工行即可加入/移除项目成员
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="w-12 px-3 py-2 font-medium">选</th>
                      <th className="px-3 py-2 font-medium">姓名</th>
                      <th className="px-3 py-2 font-medium">部门</th>
                      <th className="px-3 py-2 font-medium">岗位</th>
                      <th className="px-3 py-2 text-right font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const on = selectedUserIds.has(u.id)
                      return (
                        <tr
                          key={u.id}
                          onClick={() => toggleMember(u)}
                          className={cn(
                            'cursor-pointer border-t transition-colors hover:bg-muted/40',
                            on && 'bg-primary/5',
                          )}
                        >
                          <td className="px-3 py-2">
                            <span
                              className={cn(
                                'flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                                on
                                  ? 'border-primary bg-primary text-white'
                                  : 'border-muted-foreground/40 text-transparent',
                              )}
                            >
                              {on && <Check className="h-3 w-3" />}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-medium">{u.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">{u.deptPath}</td>
                          <td className="px-3 py-2 text-muted-foreground">{u.jobTitle ?? '—'}</td>
                          <td className="px-3 py-2 text-right">
                            {on ? (
                              <Badge className="bg-primary/10 text-primary">✓ 已加入</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">点击加入</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {filteredUsers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                          无匹配员工
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* 已选成员（通栏表格：角色 / 头衔 / 移除） */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheck className="h-4 w-4" /> 已选成员（{memberRows.length + 1} 人，含您）
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/80 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">姓名</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">部门 / 岗位</th>
                    <th className="w-32 px-3 py-2 font-medium">项目角色</th>
                    <th className="w-36 px-3 py-2 font-medium">头衔（选填）</th>
                    <th className="px-3 py-2 font-medium">需提交文件（逗号分隔）</th>
                    <th className="w-16 px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 本人（OWNER 固定） */}
                  <tr className="border-t bg-muted/30">
                    <td className="px-3 py-2 font-medium">
                      {me?.name ?? '我'}
                      <span className="ml-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        项目负责人
                      </span>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                      {(me ? userById.get(me.id)?.deptPath : null) ?? ''}{' '}
                      {(me ? userById.get(me.id)?.jobTitle : null) ?? ''}
                    </td>
                    <td className="px-3 py-2">
                      <Badge>OWNER</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">自动</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">—</td>
                    <td className="px-3 py-2" />
                  </tr>
                  {memberRows.map((r) => {
                    const u = userById.get(r.userId)
                    return (
                      <tr key={r.userId} className="border-t hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium">{u?.name ?? r.userId}</td>
                        <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                          {u?.deptPath} {u?.jobTitle ? `· ${u.jobTitle}` : ''}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={r.role}
                            onValueChange={(v) => updateMemberRow(r.userId, { role: v as MemberRow['role'] })}
                          >
                            <SelectTrigger className="h-8 w-[120px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="MANAGER">项目管理</SelectItem>
                              <SelectItem value="MEMBER">成员</SelectItem>
                              <SelectItem value="VIEWER">只读</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            value={r.title}
                            onChange={(e) => updateMemberRow(r.userId, { title: e.target.value })}
                            placeholder="头衔（选填）"
                            className="h-8"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            value={r.deliverables.join(',')}
                            onChange={(e) =>
                              updateMemberRow(r.userId, {
                                deliverables: e.target.value
                                  .split(/[,，]/)
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="需提交文件，逗号分隔（如：电气采购清单,电气原理图,程序）"
                            className="h-8 min-w-[220px]"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-destructive hover:text-destructive"
                            onClick={() => toggleMember(u!)}
                          >
                            移除
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                  {memberRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                        未选择其他成员；各阶段负责人会自动加入项目
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* 阶段负责人（通栏表格：自动匹配 / 改派） */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheck className="h-4 w-4" /> 阶段负责人（岗位自动匹配，可改派）
              </CardTitle>
              <CardDescription>
                {assignedCount}/{stageOwners.length} 已分配
                {pendingCount > 0 ? (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">
                    · {pendingCount} 个待分配（岗位无人或未指定）
                  </span>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/80 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-14 px-3 py-2 font-medium">阶段</th>
                    <th className="px-3 py-2 font-medium">阶段名称</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">负责岗位</th>
                    <th className="w-48 px-3 py-2 font-medium">负责人</th>
                    <th className="w-20 px-3 py-2 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {stageOwners.map((s) => (
                    <tr key={s.order} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        PH{String(s.order).padStart(2, '0')}
                      </td>
                      <td className="px-3 py-2">{s.stage.name}</td>
                      <td className="hidden px-3 py-2 sm:table-cell">
                        {s.stage.ownerJobTitle ? (
                          <Badge variant="outline" className="font-normal">
                            {s.stage.ownerJobTitle}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">未指定</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Select value={s.override ?? AUTO} onValueChange={(v) => setOwner(s.order, v)}>
                          <SelectTrigger
                            className={cn(
                              'h-8 w-full',
                              s.pending && 'border-amber-500 text-amber-600 dark:text-amber-400',
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={AUTO}>
                              {s.autoName
                                ? `自动匹配：${s.autoName}`
                                : s.stage.ownerJobTitle
                                  ? `自动匹配（${s.stage.ownerJobTitle} 无人）`
                                  : '未指定岗位（待分配）'}
                            </SelectItem>
                            {allUsers.map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {u.name}
                                {u.jobTitle ? `（${u.jobTitle}）` : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2">
                        {s.pending ? (
                          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5" /> 待分配
                          </span>
                        ) : s.autoMatched ? (
                          <span className="text-xs text-muted-foreground">自动</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">已改派</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* 步骤④：预览确认 */}
      {step === 4 ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>创建清单摘要</CardTitle>
              <CardDescription>确认无误后提交；提交后将在事务内实例化流程并创建项目群</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
                <Kv k="项目名称" v={basic.name} />
                <Kv
                  k="项目编号"
                  v={basic.code.trim() || `自动生成（DEMO${String(new Date(basic.signedAt || Date.now()).getFullYear()).slice(-2)}xxx）`}
                />
                <Kv k="客户主体" v={customers.find((c) => c.id === basic.customerId)?.name ?? '—'} />
                <Kv k="合同编号" v={basic.contractNo || '—'} />
                <Kv k="合同金额" v={basic.amount ? `¥ ${basic.amount}` : '—'} />
                <Kv k="施工地" v={basic.location || '—'} />
                <Kv k="优先级" v={PRIORITY_LABEL[basic.priority]} />
                <Kv
                  k="日期"
                  v={`${basic.signedAt || '—'} 签约 · ${basic.plannedStart || '—'} 开工 · ${basic.plannedEnd || '—'} 结束`}
                />
                <Kv k="流程模板" v={templateMode === 'custom' ? customSavedName : activeTemplate?.name} />
                <Kv k="阶段数" v={`${stageOwners.length} 个`} />
                <Kv k="项目成员" v={`${memberRows.length + 1} 人（含您 OWNER）`} />
                <Kv k="交付文件条目" v="按模板阶段交付物自动预生成" />
              </div>

              <div className="rounded-md border p-3">
                <p className="mb-2 text-sm font-medium">
                  负责人分配：{assignedCount}/{stageOwners.length} 已分配
                  {pendingCount > 0 ? (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      {pendingCount} 个待分配
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-1">
                  {stageOwners.map((s) => (
                    <Badge
                      key={s.order}
                      variant={s.pending ? 'destructive' : 'secondary'}
                      className="font-normal"
                      title={
                        s.pending
                          ? `${s.stage.ownerJobTitle ?? '未指定岗位'} · 待分配`
                          : `${s.owner?.name}${s.autoMatched ? '（自动匹配）' : '（已改派）'}`
                      }
                    >
                      PH{String(s.order).padStart(2, '0')} {s.stage.name} ·{' '}
                      {s.owner?.name ?? '待分配'}
                    </Badge>
                  ))}
                </div>
                {pendingCount > 0 ? (
                  <p className="mt-2 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    待分配提醒：项目创建后可在根树阶段卡上继续改派负责人；下列阶段当前无人负责：
                    {stageOwners
                      .filter((s) => s.pending)
                      .map((s) => ` PH${String(s.order).padStart(2, '0')} ${s.stage.name}（${s.stage.ownerJobTitle ?? '未指定岗位'}）`)
                      .join('、')}
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                注：项目编号留空时按「签约年份 + 3 位流水」自动生成，以提交时为准，上方预览仅供参考。
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-center">
            <Button size="lg" onClick={submit} disabled={submitting} className="min-w-48">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
              提交并创建项目
            </Button>
          </div>
        </div>
      ) : null}

      {/* 底部导航 */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || submitting}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 上一步
        </Button>
        {step < 4 ? (
          <Button onClick={next}>
            下一步 <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">提交后将跳转项目根树</span>
        )}
      </div>
    </div>
  )
}

// ───────────────────────────── 子组件 ─────────────────────────────

function Kv({ k, v }: { k: string; v?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 flex-1 break-all font-medium">{v || '—'}</span>
    </div>
  )
}

/** 部门树选人（递归，可折叠） */
function DeptTreePicker({
  node,
  selected,
  onToggle,
}: {
  node: DeptNode
  selected: Set<string>
  onToggle: (u: DeptMemberBrief) => void
}) {
  const [open, setOpen] = React.useState(false)
  const hasMembers = node.members.length > 0
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-muted"
        onClick={() => hasMembers && setOpen((o) => !o)}
      >
        {hasMembers ? (
          open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5" />
        )}
        <span className="font-medium">{node.name}</span>
        <span className="text-xs text-muted-foreground">（{node.memberCount} 人）</span>
      </button>
      {open ? (
        <div className="ml-4 space-y-0.5 border-l pl-2">
          {node.members.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => onToggle(m)}
                className="h-3.5 w-3.5"
              />
              <span>{m.name}</span>
              <span className="text-xs text-muted-foreground">{m.jobTitle ?? ''}</span>
            </label>
          ))}
          {node.children.map((c) => (
            <DeptTreePicker key={c.id} node={c} selected={selected} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
