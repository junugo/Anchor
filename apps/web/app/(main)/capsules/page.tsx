'use client'

import { useEffect, useState, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { useAnchor } from '../../components/AnchorProvider'
import type { TimeCapsule } from '@anchor/types'

const TRIGGER_LABELS: Record<string, string> = {
  deep_night:   '深夜',
  after_break:  '中断后',
  dissociation: '解离时',
  wakeup:       '起床后',
}

const TRIGGERS = ['deep_night', 'after_break', 'dissociation', 'wakeup'] as const

export default function CapsulesPage() {
  const { api } = useAnchor()
  const [capsules, setCapsules] = useState<TimeCapsule[]>([])
  const [content, setContent] = useState('')
  const [trigger, setTrigger] = useState<typeof TRIGGERS[number]>('wakeup')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    const result = await api.getCapsules()
    if (result.ok) setCapsules(result.data)
  }, [api])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!content.trim() || saving) return
    setSaving(true)
    await fetch('/api/capsules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.trim(), trigger }),
    })
    setContent('')
    await load()
    setSaving(false)
  }

  async function remove(id: number) {
    setRemoving(s => new Set(s).add(id))
    await fetch(`/api/capsules/${id}`, { method: 'DELETE' })
    setCapsules(c => c.filter(x => x.id !== id))
    setRemoving(s => { const n = new Set(s); n.delete(id); return n })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">时间胶囊</h1>
        <p className="page-subtitle">给未来状态不好的自己留言，Anchor 会在合适的时机播放</p>
      </div>

      <div className="section">
        <p className="section-title">新建胶囊</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <textarea
            className="textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="写给未来的自己…（如：我知道你现在不想动，但去喝口水就好）"
            rows={3}
          />
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <select
              className="select"
              value={trigger}
              onChange={e => setTrigger(e.target.value as typeof TRIGGERS[number])}
              style={{ width: 'auto', flex: 'none' }}
            >
              {TRIGGERS.map(t => (
                <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={!content.trim() || saving}
              style={{ marginLeft: 'auto' }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      <div className="section">
        <p className="section-title">已保存</p>
        {capsules.length === 0 ? (
          <div className="empty-state">
            <p>还没有时间胶囊</p>
          </div>
        ) : (
          <div className="list-group">
            {capsules.map((c, idx) => (
              <div
                key={c.id}
                className="list-item"
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '8px',
                  opacity: removing.has(c.id) ? 0.4 : 1,
                  transition: 'opacity 150ms',
                  borderBottom: idx === capsules.length - 1 ? 'none' : undefined,
                }}
              >
                <div style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <span className="badge" style={{ marginBottom: '6px' }}>
                      {TRIGGER_LABELS[c.trigger]}
                    </span>
                    <p style={{ fontSize: '14px', lineHeight: '1.6', marginTop: '4px' }}>{c.content}</p>
                    {c.last_played_at != null && (
                      <p style={{ fontSize: '12px', color: 'var(--text-disabled)', marginTop: '4px' }}>
                        上次播放：{new Date(c.last_played_at * 1000).toLocaleDateString('zh-CN')}
                      </p>
                    )}
                  </div>
                  <button
                    className="btn btn-ghost"
                    disabled={removing.has(c.id)}
                    onClick={() => remove(c.id)}
                    style={{ width: '32px', padding: 0, justifyContent: 'center', flexShrink: 0 }}
                    data-tooltip="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
