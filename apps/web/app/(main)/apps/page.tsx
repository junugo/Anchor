'use client'

import { useState } from 'react'
import useSWR, { mutate } from 'swr'
import { Trash2, Check, CheckCheck } from 'lucide-react'
import { ConfirmDialog } from '@anchor/ui'
import { useWsEvents } from '@/lib/ws/useWsEvents'

// ── 三类原始行 ─────────────────────────────────────────────────
interface AppRow {
  id: number
  package_name: string
  app_name: string
  high_stimulus: boolean
  is_work: boolean
  classification_source: string
  user_modified: boolean
  reviewed: boolean
  version_name: string | null
  category: string | null
  process_name: string | null
  icon_base64: string | null
  updated_at: number
}

interface SiteRow {
  id: number
  domain: string
  site_name: string
  high_stimulus: boolean
  is_work: boolean
  classification_source: string
  user_modified: boolean
  reviewed: boolean
  url: string | null
  favicon_base64: string | null
  updated_at: number
}

interface ProcessRow {
  id: number
  process_name: string
  display_name: string
  high_stimulus: boolean
  is_work: boolean
  classification_source: string
  user_modified: boolean
  reviewed: boolean
  icon_base64: string | null
  updated_at: number
}

// ── 统一行模型 ─────────────────────────────────────────────────
type Kind = 'windows' | 'android' | 'site'

interface UnifiedRow {
  kind: Kind
  key: string            // package_name / domain / process_name
  name: string
  sub: string            // 次要标识（包名/域名/进程名）
  icon: string | null    // base64（site 的 favicon 已是 data: 前缀，app/process 是纯 base64）
  iconIsDataUri: boolean
  high_stimulus: boolean
  is_work: boolean
  source: string
  user_modified: boolean
  reviewed: boolean
  updated_at: number
  app?: AppRow
  site?: SiteRow
  process?: ProcessRow
}

const KIND_LABEL: Record<Kind, string> = { windows: 'Windows', android: 'Android', site: '网站' }
// 平台标识色：与 /dev 信号监控的 SOURCE_COLORS 一致（desktop 蓝 / android 橙 / chrome 绿）
const KIND_COLOR: Record<Kind, string> = { windows: '#2563eb', android: '#ea580c', site: '#16a34a' }

const CLASSIFICATIONS_URLS = [
  '/api/apps/classifications',
  '/api/sites/classifications',
  '/api/processes/classifications',
] as const

function refreshAll() {
  for (const u of CLASSIFICATIONS_URLS) mutate(u)
}

export default function AppsPage() {
  const fetcher = (url: string) => fetch(url).then(r => r.json())
  const appsRes = useSWR<{ classifications: AppRow[] }>('/api/apps/classifications', fetcher)
  const sitesRes = useSWR<{ classifications: SiteRow[] }>('/api/sites/classifications', fetcher)
  const procsRes = useSWR<{ classifications: ProcessRow[] }>('/api/processes/classifications', fetcher)

  // 订阅 WS 事件，任一端分类变更时实时刷新列表
  useWsEvents((msg) => {
    if (
      msg.type === 'app:classification_updated' || msg.type === 'app:classification_deleted' ||
      msg.type === 'site:classification_updated' || msg.type === 'site:classification_deleted' ||
      msg.type === 'process:classification_updated' || msg.type === 'process:classification_deleted' ||
      msg.type === 'app:classification_reviewed' || msg.type === 'site:classification_reviewed' ||
      msg.type === 'process:classification_reviewed'
    ) {
      refreshAll()
    }
  })

  const [platform, setPlatform] = useState<'all' | Kind>('all')
  const [category, setCategory] = useState<'all' | 'unread' | 'high' | 'work' | 'neutral'>('all')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [deleteRow, setDeleteRow] = useState<UnifiedRow | null>(null)

  const error = appsRes.error || sitesRes.error || procsRes.error
  const loading = !appsRes.data && !sitesRes.data && !procsRes.data

  const isPending = (r: UnifiedRow) => r.source === 'pending'
  // 未读 = AI/兜底 已出结果但用户还没复核；pending（分类中）不算
  const isUnread = (r: UnifiedRow) => !r.reviewed && !isPending(r)

  const rows: UnifiedRow[] = [
    ...(appsRes.data?.classifications ?? []).map(a => ({
      kind: 'android' as const,
      key: a.package_name,
      name: a.app_name,
      sub: a.package_name,
      icon: a.icon_base64,
      iconIsDataUri: false,
      high_stimulus: a.high_stimulus,
      is_work: a.is_work,
      source: a.classification_source,
      user_modified: a.user_modified,
      reviewed: a.reviewed,
      updated_at: a.updated_at,
      app: a,
    })),
    ...(sitesRes.data?.classifications ?? []).map(s => ({
      kind: 'site' as const,
      key: s.domain,
      name: s.site_name,
      sub: s.domain,
      icon: s.favicon_base64,
      iconIsDataUri: true,
      high_stimulus: s.high_stimulus,
      is_work: s.is_work,
      source: s.classification_source,
      user_modified: s.user_modified,
      reviewed: s.reviewed,
      updated_at: s.updated_at,
      site: s,
    })),
    ...(procsRes.data?.classifications ?? []).map(p => ({
      kind: 'windows' as const,
      key: p.process_name,
      name: p.display_name,
      sub: p.process_name,
      icon: p.icon_base64,
      iconIsDataUri: false,
      high_stimulus: p.high_stimulus,
      is_work: p.is_work,
      source: p.classification_source,
      user_modified: p.user_modified,
      reviewed: p.reviewed,
      updated_at: p.updated_at,
      process: p,
    })),
  ].sort((a, b) => {
    // 待复核置顶（AI 新分类最需要人看），其余按更新时间倒序
    const ua = isUnread(a) ? 1 : 0
    const ub = isUnread(b) ? 1 : 0
    if (ua !== ub) return ub - ua
    return b.updated_at - a.updated_at
  })

  const filtered = rows.filter(r => {
    if (platform !== 'all' && r.kind !== platform) return false
    if (category === 'unread') return isUnread(r)
    if (category === 'high') return r.high_stimulus && !isPending(r)
    if (category === 'work') return r.is_work && !isPending(r)
    if (category === 'neutral') return !r.high_stimulus && !r.is_work && !isPending(r)
    return true
  })

  const countOf = (k: Kind) => rows.filter(r => r.kind === k).length
  const unreadCount = rows.filter(isUnread).length
  const highCount = rows.filter(r => r.high_stimulus && !isPending(r)).length
  const workCount = rows.filter(r => r.is_work && !isPending(r)).length
  const neutralCount = rows.filter(r => !r.high_stimulus && !r.is_work && !isPending(r)).length

  // 三态分类设置：高刺激 / 中性 / 工作（互斥）
  const handleSetCategory = async (row: UnifiedRow, target: 'high' | 'neutral' | 'work') => {
    const body = {
      high_stimulus: target === 'high',
      is_work: target === 'work',
    }
    if (row.kind === 'android') {
      await fetch('/api/apps/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_name: row.key, app_name: row.name, ...body }),
      })
    } else if (row.kind === 'site') {
      await fetch('/api/sites/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: row.key, site_name: row.name, ...body }),
      })
    } else {
      await fetch('/api/processes/classifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ process_name: row.key, display_name: row.name, ...body }),
      })
    }
    refreshAll()
  }

  const handleDelete = async () => {
    if (!deleteRow) return
    const row = deleteRow
    setDeleteRow(null)
    const base =
      row.kind === 'android' ? '/api/apps/classifications' :
      row.kind === 'site' ? '/api/sites/classifications' :
      '/api/processes/classifications'
    await fetch(`${base}/${encodeURIComponent(row.key)}`, { method: 'DELETE' })
    refreshAll()
  }

  // 单条标记已复核（看了没问题，不改分类）
  const handleMarkReviewed = async (row: UnifiedRow) => {
    await fetch('/api/classifications/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: row.kind === 'android' ? 'app' : row.kind === 'site' ? 'site' : 'process',
        keys: [row.key],
      }),
    })
    refreshAll()
  }

  // 一键消除未读：全部标记已复核
  const handleReviewAll = async () => {
    await fetch('/api/classifications/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    refreshAll()
  }

  if (error) return <div className="apps-page"><p style={{ color: 'var(--color-curfew)' }}>加载失败</p></div>
  if (loading) return <div className="apps-page"><p style={{ color: 'var(--text-secondary)' }}>加载中...</p></div>

  return (
    <div className="apps-page">
      <header className="page-header">
        <h1 className="page-title">应用与网站管理</h1>
        <p className="page-subtitle">统一管理 Windows 程序、Android 应用与网站分类，控制工作推断与宵禁干预</p>
        {unreadCount > 0 && (
          <button onClick={handleReviewAll} className="btn btn-secondary" title="全部标记为已复核"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-curfew)' }}>
            <CheckCheck size={15} />
            一键消除未读（{unreadCount}）
          </button>
        )}
      </header>

      <div className="apps-filter-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => setPlatform('all')} className={`btn ${platform === 'all' ? 'btn-primary' : 'btn-secondary'}`}>
          全部平台 ({rows.length})
        </button>
        <button onClick={() => setPlatform('windows')} className={`btn ${platform === 'windows' ? 'btn-primary' : 'btn-secondary'}`}>
          Windows ({countOf('windows')})
        </button>
        <button onClick={() => setPlatform('android')} className={`btn ${platform === 'android' ? 'btn-primary' : 'btn-secondary'}`}>
          Android ({countOf('android')})
        </button>
        <button onClick={() => setPlatform('site')} className={`btn ${platform === 'site' ? 'btn-primary' : 'btn-secondary'}`}>
          网站 ({countOf('site')})
        </button>

        <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 var(--space-2)' }} />

        <button onClick={() => setCategory('unread')} className={`btn ${category === 'unread' ? 'btn-primary' : 'btn-secondary'}`}
          style={category === 'unread' ? { background: 'var(--color-curfew)', borderColor: 'var(--color-curfew)' } : { color: unreadCount > 0 ? 'var(--color-curfew)' : undefined }}>
          待复核 ({unreadCount})
        </button>
        <button onClick={() => setCategory('all')} className={`btn ${category === 'all' ? 'btn-primary' : 'btn-secondary'}`}>
          全部分类
        </button>
        <button onClick={() => setCategory('high')} className={`btn ${category === 'high' ? 'btn-primary' : 'btn-secondary'}`}>
          高刺激 ({highCount})
        </button>
        <button onClick={() => setCategory('work')} className={`btn ${category === 'work' ? 'btn-primary' : 'btn-secondary'}`}>
          工作 ({workCount})
        </button>
        <button onClick={() => setCategory('neutral')} className={`btn ${category === 'neutral' ? 'btn-primary' : 'btn-secondary'}`}>
          中性 ({neutralCount})
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          {category === 'unread' ? '没有待复核的分类，AI 新分类完成时会出现在这里' :
            platform === 'all' && category === 'all' ? '暂无分类记录' : '暂无此类条目'}
        </div>
      ) : (
        <div className="list-group">
          <table className="data-table apps-table" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col />
              <col style={{ width: 92 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 132 }} />
              <col style={{ width: 236 }} />
            </colgroup>
            <thead>
              <tr>
                <th>名称</th>
                <th>平台</th>
                <th>分类</th>
                <th>来源</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <ClassificationRow
                  key={`${row.kind}:${row.key}`}
                  row={row}
                  expanded={expandedKey === `${row.kind}:${row.key}`}
                  onExpand={() => setExpandedKey(expandedKey === `${row.kind}:${row.key}` ? null : `${row.kind}:${row.key}`)}
                  onSetCategory={(target) => handleSetCategory(row, target)}
                  onMarkReviewed={() => handleMarkReviewed(row)}
                  onDelete={() => setDeleteRow(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={deleteRow !== null}
        title="删除分类"
        description={`确定删除「${deleteRow?.name ?? ''}」的分类吗？`}
        confirmLabel="删除"
        onConfirm={handleDelete}
        onCancel={() => setDeleteRow(null)}
      />
    </div>
  )
}

function RowIcon({ row }: { row: UnifiedRow }) {
  const [failed, setFailed] = useState(false)
  const boxStyle: React.CSSProperties = {
    width: 32, height: 32, borderRadius: 'var(--radius-md)', flexShrink: 0,
    background: 'var(--surface-raised)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    color: 'var(--text-secondary)', fontSize: 14, fontWeight: 600,
  }
  if (!row.icon || failed) {
    return <div style={boxStyle}>{(row.name || row.key).charAt(0).toUpperCase()}</div>
  }
  const src = row.iconIsDataUri ? row.icon : `data:image/png;base64,${row.icon}`
  return (
    <div style={boxStyle}>
      <img src={src} alt="" width={20} height={20} onError={() => setFailed(true)} />
    </div>
  )
}

function ClassificationRow({
  row,
  expanded,
  onExpand,
  onSetCategory,
  onMarkReviewed,
  onDelete,
}: {
  row: UnifiedRow
  expanded: boolean
  onExpand: () => void
  onSetCategory: (target: 'high' | 'neutral' | 'work') => void
  onMarkReviewed: () => void
  onDelete: () => void
}) {
  const pending = row.source === 'pending'
  const unread = !row.reviewed && !pending
  const current: 'high' | 'neutral' | 'work' = row.high_stimulus ? 'high' : row.is_work ? 'work' : 'neutral'
  const kindColor = KIND_COLOR[row.kind]

  const ellipsis: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  return (
    <>
      <tr className="apps-row" onClick={onExpand}>
        <td style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <RowIcon row={row} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500, color: 'var(--text-primary)', ...ellipsis }} title={row.name}>{row.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', ...ellipsis }} title={row.sub}>{row.sub}</div>
            </div>
          </div>
        </td>
        <td>
          <span className="badge" style={{ background: kindColor + '22', color: kindColor }}>{KIND_LABEL[row.kind]}</span>
        </td>
        <td>
          {pending ? (
            <span className="badge badge-soft">分类中…</span>
          ) : (
            <span className={`badge ${current === 'high' ? 'badge-curfew' : current === 'work' ? 'badge-passive' : 'badge-soft'}`}>
              {current === 'high' ? '高刺激' : current === 'work' ? '工作' : '中性'}
            </span>
          )}
        </td>
        <td style={{ overflow: 'hidden' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {row.source === 'ai' && 'AI 分类'}
            {row.source === 'preset' && '预设'}
            {row.source === 'user_manual' && '用户添加'}
            {row.source === 'fallback' && '默认'}
            {row.source === 'pending' && '等待结果'}
            {row.user_modified && <span style={{ marginLeft: 4, color: 'var(--accent)' }}>已修改</span>}
          </span>
          {unread && (
            <span className="badge badge-curfew" style={{ marginLeft: 6 }}>待复核</span>
          )}
        </td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {!pending && (
              <CategorySegment current={current} onSelect={onSetCategory} />
            )}
            {unread && (
              <button onClick={onMarkReviewed} className="btn btn-ghost" title="标记已复核（分类无误）"
                style={{ color: 'var(--color-passive)', padding: '4px', lineHeight: 0 }}>
                <Check size={15} />
              </button>
            )}
            <button onClick={onDelete} className="btn btn-ghost" title="删除分类"
              style={{ color: 'var(--color-curfew)', padding: '4px', lineHeight: 0 }}>
              <Trash2 size={15} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--surface-raised)' }}>
          <td colSpan={5}>
            <RowDetails row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

// 三态分段控件：高刺激 / 中性 / 工作（互斥，当前项实色填充）
const SEGMENT_DEFS = [
  { key: 'high', label: '高刺激', color: 'var(--color-curfew)' },
  { key: 'neutral', label: '中性', color: 'var(--text-secondary)' },
  { key: 'work', label: '工作', color: 'var(--color-passive)' },
] as const

function CategorySegment({
  current,
  onSelect,
}: {
  current: 'high' | 'neutral' | 'work'
  onSelect: (target: 'high' | 'neutral' | 'work') => void
}) {
  return (
    <div style={{
      display: 'inline-flex',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      {SEGMENT_DEFS.map((seg, i) => {
        const active = current === seg.key
        return (
          <button
            key={seg.key}
            onClick={() => onSelect(seg.key)}
            disabled={active}
            style={{
              border: 'none',
              borderLeft: i > 0 ? '1px solid var(--border)' : 'none',
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: active ? 600 : 400,
              cursor: active ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
              background: active ? seg.color : 'transparent',
              color: active ? '#fff' : seg.color,
            }}
          >
            {seg.label}
          </button>
        )
      })}
    </div>
  )
}

function RowDetails({ row }: { row: UnifiedRow }) {
  const updatedAt = new Date(row.updated_at * 1000).toLocaleString('zh-CN')
  const itemStyle: React.CSSProperties = { fontSize: 13 }
  const labelStyle: React.CSSProperties = { color: 'var(--text-secondary)' }
  const valueStyle: React.CSSProperties = { marginLeft: 8, color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 12 }

  const items: Array<[string, string]> = []
  if (row.kind === 'android' && row.app) {
    items.push(['版本号', row.app.version_name || '未知'])
    items.push(['应用分类', row.app.category || '未知'])
    items.push(['进程名', row.app.process_name || '未知'])
  } else if (row.kind === 'site' && row.site) {
    items.push(['域名', row.site.domain])
    items.push(['访问地址', row.site.url || '未知'])
  } else if (row.kind === 'windows' && row.process) {
    items.push(['进程名', row.process.process_name])
  }
  items.push(['最近更新', updatedAt])
  items.push(['复核状态', row.reviewed ? '已复核' : row.source === 'pending' ? '分类中' : '待复核'])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)' }}>
      {items.map(([label, value]) => (
        <div key={label} style={itemStyle}>
          <span style={labelStyle}>{label}:</span>
          <span style={valueStyle}>{value}</span>
        </div>
      ))}
    </div>
  )
}
