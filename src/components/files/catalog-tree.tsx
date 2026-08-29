'use client'

/**
 * CatalogTree —— 文件目录管理页左区目录树（§8.2④）
 *
 * - 点击节点 → 选中该目录（联动右侧条目表过滤）
 * - 右键节点 → 上下文菜单：新建子目录 / 重命名 / 删除（canEdit 控制显隐）
 * - 顶部「新建根目录」按钮（canEdit 控制）
 * - 每节点显示条目计数徽章 + 关联阶段
 */

import { useState } from 'react'
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { CatalogNode } from '@/types/files'

/** 文件条目状态 → 目录树内的状态色点 */
const REQ_STATUS_DOT: Record<string, string> = {
  APPROVED: 'bg-emerald-500',
  REJECTED: 'bg-red-500',
  SUBMITTED: 'bg-blue-500',
  REVIEWING: 'bg-amber-500',
  WAITING: 'bg-slate-400',
  NA: 'bg-zinc-400',
  OBSOLETED: 'bg-zinc-300',
}

interface CatalogTreeProps {
  projectName?: string
  nodes: CatalogNode[]
  selectedId: string | null
  onSelect: (node: CatalogNode | null) => void
  canEdit: boolean
  onAddRoot: () => void
  onAddChild: (parent: CatalogNode) => void
  onEdit: (node: CatalogNode) => void
  onDelete: (node: CatalogNode) => void
}

interface MenuState {
  x: number
  y: number
  node: CatalogNode
}

export function CatalogTree({
  projectName,
  nodes,
  selectedId,
  onSelect,
  canEdit,
  onAddRoot,
  onAddChild,
  onEdit,
  onDelete,
}: CatalogTreeProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 项目根目录默认展开 */
  const [projectRootOpen, setProjectRootOpen] = useState(true)

  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }))

  const closeMenu = () => setMenu(null)

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-muted-foreground">目录树</span>
        {canEdit && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onAddRoot}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            根目录
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto rounded-md border bg-background p-2">
        {/* 项目根目录（可展开节点：项目根 → 阶段目录 → 条目） */}
        {projectName && (
          <div className="mb-1">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setProjectRootOpen((o) => !o)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-primary">
                {projectRootOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </span>
              <Building2 className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate" title={projectName}>
                {projectName}
              </span>
              <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">
                {nodes.reduce((sum, n) => sum + n.requirementCount, 0)} 条目
              </span>
            </div>
            {projectRootOpen && (
              <ul className="mt-0.5 space-y-0.5">
                {nodes.map((n) => (
                  <TreeNode
                    key={n.id}
                    node={n}
                    depth={0}
                    expanded={expanded}
                    selectedId={selectedId}
                    canEdit={canEdit}
                    onToggle={toggle}
                    onSelect={onSelect}
                    onMenu={setMenu}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        {!projectName &&
          (nodes.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">暂无目录</div>
          ) : (
            <ul className="space-y-0.5">
              {nodes.map((n) => (
                <TreeNode
                  key={n.id}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  selectedId={selectedId}
                  canEdit={canEdit}
                  onToggle={toggle}
                  onSelect={onSelect}
                  onMenu={setMenu}
                />
              ))}
            </ul>
          ))}
      </div>

      {/* 右键上下文菜单 */}
      {menu && canEdit && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeMenu} onContextMenu={(e) => {
            e.preventDefault()
            closeMenu()
          }} />
          <div
            className="fixed z-50 min-w-[160px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem icon={<FolderPlus className="h-4 w-4" />} label="新建子目录" onClick={() => { onAddChild(menu.node); closeMenu() }} />
            <MenuItem icon={<Pencil className="h-4 w-4" />} label="重命名" onClick={() => { onEdit(menu.node); closeMenu() }} />
            <MenuItem icon={<Trash2 className="h-4 w-4" />} label="删除" danger onClick={() => { onDelete(menu.node); closeMenu() }} />
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedId,
  canEdit,
  onToggle,
  onSelect,
  onMenu,
}: {
  node: CatalogNode
  depth: number
  expanded: Record<string, boolean>
  selectedId: string | null
  canEdit: boolean
  onToggle: (id: string) => void
  onSelect: (node: CatalogNode | null) => void
  onMenu: (m: MenuState) => void
}) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded[node.id]
  const selected = selectedId === node.id

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(selected ? null : node)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect(selected ? null : node)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu({ x: e.clientX, y: e.clientY, node })
        }}
        className={cn(
          'group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1.5 text-sm',
          selected ? 'bg-primary/10 text-primary' : 'hover:bg-muted/60',
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggle(node.id)
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
          aria-label={isOpen ? '收起' : '展开'}
        >
          {hasChildren ? (
            isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
          ) : null}
        </button>
        {isOpen ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        )}
        <span className="min-w-0 flex-1 truncate" title={node.name}>
          {node.name}
        </span>
        {node.phaseCode && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{node.phaseCode}</span>
        )}
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          <FileText className="h-3 w-3" />
          {node.requirementCount}
        </span>
      </div>
      {hasChildren && isOpen && (
        <ul className="space-y-0.5">
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              selectedId={selectedId}
              canEdit={canEdit}
              onToggle={onToggle}
              onSelect={onSelect}
              onMenu={onMenu}
            />
          ))}
        </ul>
      )}
      {/* 目录下的文件条目（挂到项目/目录下形成层级） */}
      {isOpen && node.requirements.length > 0 && (
        <ul className="space-y-0.5">
          {node.requirements.map((r) => (
            <li
              key={r.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(node)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-6 text-sm text-muted-foreground hover:bg-muted/60"
              style={{ paddingLeft: `${depth * 14 + 26}px` }}
              title={r.name}
            >
              <span className={cn('h-2 w-2 shrink-0 rounded-full', REQ_STATUS_DOT[r.status] ?? 'bg-slate-400')} />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
