'use client'

/**
 * /organization/externals 外部主体 —— 依据《开发文档-项目管理系统重构》§7.2、§10.4、§10.7
 *
 * 四类 tab（客户/供应商/外协/外包商，附「其他」）；TanStack Table 列表 + 服务端分页 + 搜索；
 * 联系人管理 Dialog；ADMIN 增删改 + external-orgs.xlsx 导入（模板下载/试运行/错误行报告）+ 导出。
 */

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import {
  Building,
  Contact as ContactIcon,
  Download,
  FileSpreadsheet,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  Upload,
  Users2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable, TablePagination } from '@/components/ui/data-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ImportResultDialog } from '@/components/organization/import-result-dialog'
import {
  OrgService,
  ORG_TYPE_LABEL_MAP,
  ExternalOrg,
  ExternalOrgTypeLabel,
  ExternalContact,
  ImportResult,
} from '@/services/org'
import { ApiError } from '@/services/api'
import { downloadOrgsTemplate, exportOrgs } from '@/lib/excel-templates'
import { useAuthStore } from '@/store/auth'
import { ExternalOrgScopeConfig } from '@/components/settings/external-org-scope-config'
import { globalConfirm } from '@/lib/global-confirm'

const TYPE_TABS: Array<{ value: ExternalOrgTypeLabel; label: string }> = [
  { value: 'CUSTOMER', label: '客户' },
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'OUTSOURCER', label: '外协' },
  { value: 'CONTRACTOR', label: '外包商' },
  { value: 'OTHER', label: '其他' },
]

// ───────────────────────────── 主体表单 ─────────────────────────────

interface OrgForm {
  id?: string
  name: string
  type: ExternalOrgTypeLabel
  phone: string
  address: string
  remark: string
}

const EMPTY_ORG: OrgForm = { name: '', type: 'CUSTOMER', phone: '', address: '', remark: '' }

// ───────────────────────────── 联系人表单 ─────────────────────────────

interface ContactForm {
  id?: string
  name: string
  title: string
  phone: string
  email: string
}

const EMPTY_CONTACT: ContactForm = { name: '', title: '', phone: '', email: '' }

export default function ExternalsPage() {
  // 仅 ADMIN 可见（权限 V2 2026-08-21：组织架构整体并入管理模块）
  // hooks 全部前置，无权限早退后移（rules-of-hooks：条件 return 不得早于 hook 调用）
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'ADMIN'
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [type, setType] = React.useState<ExternalOrgTypeLabel>('CUSTOMER')
  const [q, setQ] = React.useState('')
  const [debouncedQ, setDebouncedQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  const limit = 20

  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q)
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  React.useEffect(() => setPage(1), [type])

  const { data, isLoading } = useQuery({
    queryKey: ['external-orgs', type, debouncedQ, page],
    queryFn: () => OrgService.getExternalOrgs({ type, q: debouncedQ, page, limit }),
  })

  // 主体表单
  const [orgFormOpen, setOrgFormOpen] = React.useState(false)
  const [orgForm, setOrgForm] = React.useState<OrgForm>(EMPTY_ORG)
  const [saving, setSaving] = React.useState(false)
  // 外部主体类型可见性配置弹窗（2026-08-21 权限 V2.1）
  const [scopeOpen, setScopeOpen] = React.useState(false)

  // 联系人
  const [contactsOrg, setContactsOrg] = React.useState<ExternalOrg | null>(null)
  const [contactFormOpen, setContactFormOpen] = React.useState(false)
  const [contactForm, setContactForm] = React.useState<ContactForm>(EMPTY_CONTACT)

  // 导入
  const [importResult, setImportResult] = React.useState<ImportResult | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [dryRun, setDryRun] = React.useState(true)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const { data: contacts } = useQuery({
    queryKey: ['contacts', contactsOrg?.id],
    queryFn: () => OrgService.getContacts(contactsOrg!.id),
    enabled: !!contactsOrg,
  })


  // ───────────── 表格列 ─────────────

  const columns = React.useMemo<ColumnDef<ExternalOrg, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: '主体名称',
        cell: ({ row }) => (
          <div className="min-w-[160px]">
            <span className="font-medium">{row.original.name}</span>
            {!row.original.isActive && (
              <Badge variant="outline" className="ml-2 text-muted-foreground">
                已停用
              </Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: '类型',
        cell: ({ row }) => <Badge variant="secondary">{ORG_TYPE_LABEL_MAP[row.original.type]}</Badge>,
      },
      {
        id: 'contacts',
        header: '联系人',
        cell: ({ row }) => {
          const cs = row.original.contacts ?? []
          if (cs.length === 0) return <span className="text-muted-foreground">—</span>
          return (
            <button
              className="text-left text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                setContactsOrg(row.original)
              }}
            >
              {cs[0].name}
              {cs[0].title ? `（${cs[0].title}）` : ''}
              {cs.length > 1 && <span className="ml-1 text-muted-foreground">+{cs.length - 1}</span>}
            </button>
          )
        },
      },
      {
        accessorKey: 'phone',
        header: '电话',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.phone ? (
              <span className="inline-flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {row.original.phone}
              </span>
            ) : (
              '—'
            )}
          </span>
        ),
      },
      {
        accessorKey: 'remark',
        header: '备注',
        cell: ({ row }) => (
          <span className="block max-w-[240px] truncate text-muted-foreground" title={row.original.remark ?? ''}>
            {row.original.remark ?? '—'}
          </span>
        ),
      },
      ...(isAdmin
        ? [
            {
              id: 'actions',
              header: '操作',
              cell: ({ row }: { row: { original: ExternalOrg } }) => (
                <div className="flex items-center gap-1">
                  <button
                    className="rounded p-1 hover:bg-black/5"
                    title="联系人"
                    onClick={(e) => {
                      e.stopPropagation()
                      setContactsOrg(row.original)
                    }}
                  >
                    <Users2 className="h-4 w-4" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-black/5"
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation()
                      openEdit(row.original)
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    className="rounded p-1 hover:bg-black/5"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(row.original)
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </button>
                </div>
              ),
            } as ColumnDef<ExternalOrg, unknown>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin]
  )
  if (!isAdmin) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-lg font-semibold">无权限访问</h1>
          <p className="text-sm text-muted-foreground">
            外部主体仅管理员（ADMIN）可见。如需访问，请联系管理员为你提升角色。
          </p>
        </CardContent>
      </Card>
    )
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['external-orgs'] })
  }

  function openCreate() {
    setOrgForm({ ...EMPTY_ORG, type })
    setOrgFormOpen(true)
  }
  function openEdit(org: ExternalOrg) {
    setOrgForm({
      id: org.id,
      name: org.name,
      type: org.type,
      phone: org.phone ?? '',
      address: org.address ?? '',
      remark: org.remark ?? '',
    })
    setOrgFormOpen(true)
  }

  async function handleOrgSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!orgForm.name.trim()) {
      toast({ title: '请填写主体名称', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: orgForm.name.trim(),
        type: orgForm.type,
        phone: orgForm.phone.trim() || null,
        address: orgForm.address.trim() || null,
        remark: orgForm.remark.trim() || null,
      }
      if (orgForm.id) await OrgService.updateExternalOrg(orgForm.id, payload)
      else await OrgService.createExternalOrg(payload)
      toast({ description: orgForm.id ? '外部主体已更新' : '外部主体已创建' })
      setOrgFormOpen(false)
      await refresh()
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(org: ExternalOrg) {
    if (!(await globalConfirm(`确认删除「${org.name}」？其联系人将一并删除；被项目引用的主体无法删除。`))) return
    try {
      await OrgService.deleteExternalOrg(org.id)
      toast({ description: '外部主体已删除' })
      await refresh()
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!contactsOrg || !contactForm.name.trim()) {
      toast({ title: '请填写联系人姓名', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: contactForm.name.trim(),
        title: contactForm.title.trim() || null,
        phone: contactForm.phone.trim() || null,
        email: contactForm.email.trim() || null,
      }
      if (contactForm.id)
        await OrgService.updateContact(contactsOrg.id, contactForm.id, payload)
      else await OrgService.createContact(contactsOrg.id, payload)
      toast({ description: '联系人已保存' })
      setContactFormOpen(false)
      queryClient.invalidateQueries({ queryKey: ['contacts', contactsOrg.id] })
      await refresh()
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteContact(c: ExternalContact) {
    if (!contactsOrg) return
    if (!(await globalConfirm(`确认删除联系人「${c.name}」？`))) return
    try {
      await OrgService.deleteContact(contactsOrg.id, c.id)
      toast({ description: '联系人已删除' })
      queryClient.invalidateQueries({ queryKey: ['contacts', contactsOrg.id] })
      await refresh()
    } catch (err) {
      toast({
        title: '删除失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      const result = await OrgService.importExternalOrgs(file, dryRun)
      setImportResult(result)
      await refresh()
    } catch (err) {
      toast({
        title: '导入失败',
        description: err instanceof ApiError ? err.message : '请稍后重试',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleExport() {
    if (!data) return
    await exportOrgs(
      data.items.map((o) => ({
        name: o.name,
        typeLabel: ORG_TYPE_LABEL_MAP[o.type],
        contactName: o.contacts?.[0]?.name,
        contactTitle: o.contacts?.[0]?.title ?? '',
        contactPhone: o.contacts?.[0]?.phone ?? '',
        contactEmail: o.contacts?.[0]?.email ?? '',
        remark: o.remark,
      }))
    )
    toast({ description: `已导出 ${data.items.length} 条（当前筛选）` })
  }


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Building className="h-6 w-6" /> 外部主体
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            客户 / 供应商 / 外协 / 外包商档案（不登录，仅档案；§7.2）
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              仅校验
            </label>
            <Button variant="outline" size="sm" onClick={() => downloadOrgsTemplate()}>
              <FileSpreadsheet className="mr-1 h-4 w-4" /> 下载模板
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              {importing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
              导入
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-1 h-4 w-4" /> 导出
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" /> 新建主体
            </Button>
            <Button variant="outline" size="sm" onClick={() => setScopeOpen(true)}>
              <ShieldCheck className="mr-1 h-4 w-4" /> 类型可见性
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleImportFile}
            />
          </div>
        )}
      </div>

      <Tabs value={type} onValueChange={(v) => setType(v as ExternalOrgTypeLabel)}>
        <TabsList>
          {TYPE_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="搜索名称 / 电话 / 备注 / 联系人"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        loading={isLoading}
        empty="该分类下暂无外部主体"
      />
      {data && <TablePagination
        page={data.pagination.page}
        pages={data.pagination.pages}
        total={data.pagination.total}
        onPageChange={setPage}
      />}

      {/* 外部主体类型可见性配置（权限 V2.1 2026-08-21） */}
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              外部主体类型可见性
            </DialogTitle>
            <DialogDescription>
              按类型（客户/供应商/外协/承包商/其他）分别设置可见部门与用户；未配置的类型按默认规则（供应商=采购部，其余=成员项目关联）
            </DialogDescription>
          </DialogHeader>
          <ExternalOrgScopeConfig />
        </DialogContent>
      </Dialog>

      {/* 主体表单 */}
      <Dialog open={orgFormOpen} onOpenChange={setOrgFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{orgForm.id ? '编辑外部主体' : '新建外部主体'}</DialogTitle>
            <DialogDescription>同一类型下主体名称唯一。</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleOrgSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">主体名称 *</Label>
              <Input
                id="org-name"
                value={orgForm.name}
                onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })}
                placeholder="公司全称"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>类型 *</Label>
              <Select
                value={orgForm.type}
                onValueChange={(v) => setOrgForm({ ...orgForm, type: v as ExternalOrgTypeLabel })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_TABS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="org-phone">电话</Label>
                <Input
                  id="org-phone"
                  value={orgForm.phone}
                  onChange={(e) => setOrgForm({ ...orgForm, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-address">地址</Label>
                <Input
                  id="org-address"
                  value={orgForm.address}
                  onChange={(e) => setOrgForm({ ...orgForm, address: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-remark">备注</Label>
              <Textarea
                id="org-remark"
                rows={2}
                value={orgForm.remark}
                onChange={(e) => setOrgForm({ ...orgForm, remark: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOrgFormOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 联系人管理 */}
      <Dialog open={!!contactsOrg} onOpenChange={(o) => !o && setContactsOrg(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ContactIcon className="h-4 w-4" />
              {contactsOrg?.name} · 联系人
            </DialogTitle>
            <DialogDescription>
              {ORG_TYPE_LABEL_MAP[contactsOrg?.type ?? 'CUSTOMER']}
              {contactsOrg?.phone ? ` · ${contactsOrg.phone}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 space-y-2 overflow-auto">
            {(contacts ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无联系人</p>
            ) : (
              contacts!.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      {c.title && <Badge variant="secondary">{c.title}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  {isAdmin && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        className="rounded p-1 hover:bg-black/5"
                        title="编辑"
                        onClick={() => {
                          setContactForm({
                            id: c.id,
                            name: c.name,
                            title: c.title ?? '',
                            phone: c.phone ?? '',
                            email: c.email ?? '',
                          })
                          setContactFormOpen(true)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-1 hover:bg-black/5"
                        title="删除"
                        onClick={() => handleDeleteContact(c)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setContactForm(EMPTY_CONTACT)
                setContactFormOpen(true)
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> 添加联系人
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* 联系人表单 */}
      <Dialog open={contactFormOpen} onOpenChange={setContactFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{contactForm.id ? '编辑联系人' : '添加联系人'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleContactSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ct-name">姓名 *</Label>
                <Input
                  id="ct-name"
                  value={contactForm.name}
                  onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-title">职务</Label>
                <Input
                  id="ct-title"
                  value={contactForm.title}
                  onChange={(e) => setContactForm({ ...contactForm, title: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-phone">电话</Label>
                <Input
                  id="ct-phone"
                  value={contactForm.phone}
                  onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-email">邮箱</Label>
                <Input
                  id="ct-email"
                  type="email"
                  value={contactForm.email}
                  onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setContactFormOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ImportResultDialog
        open={!!importResult}
        onOpenChange={(o) => !o && setImportResult(null)}
        result={importResult}
        title="外部主体导入结果"
      />
    </div>
  )
}
