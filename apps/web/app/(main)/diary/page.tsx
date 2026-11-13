'use client'

import { useEffect, useState } from 'react'

interface DiaryEntry {
  id: number
  period_start: number
  period_end: number
  candidate_label: string
  user_choice: string | null
}

const CHOICES = [
  { key: 'active_rest',      label: '主动休息' },
  { key: 'attention_break',  label: '注意力断裂' },
  { key: 'dissociation',     label: '解离失控' },
  { key: 'ignored',          label: '忽略' },
] as const

function fmtTime(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export default function DiaryPage() {
  const [entries, setEntries] = useState<DiaryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Set<number>>(new Set())

  useEffect(() => {
    fetch('/api/diary')
      .then(r => r.json())
      .then((data: DiaryEntry[]) => setEntries(data))
      .finally(() => setLoading(false))
  }, [])

  async function confirm(id: number, choice: string) {
    setPending(s => new Set(s).add(id))
    await fetch(`/api/diary/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_choice: choice }),
    })
    setEntries(e => e.filter(x => x.id !== id))
    setPending(s => { const n = new Set(s); n.delete(id); return n })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">解离日记</h1>
        <p className="page-subtitle">确认系统记录的时段，帮助 Anchor 更好地了解你</p>
      </div>

      {loading && <p style={{ color: 'var(--text-secondary)' }}>加载中…</p>}

      {!loading && entries.length === 0 && (
        <div className="empty-state">
          <p>暂无待确认记录</p>
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="list-group">
          {entries.map((e, idx) => (
            <div
              key={e.id}
              className="list-item"
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '10px',
                opacity: pending.has(e.id) ? 0.5 : 1,
                transition: 'opacity 150ms',
                // list-item sets border-bottom; last child overrides via CSS
                borderBottom: idx === entries.length - 1 ? 'none' : undefined,
              }}
            >
              <div style={{ width: '100%' }}>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {fmtTime(e.period_start)} \u2013 {fmtTime(e.period_end)}
                </p>
                <p style={{ fontSize: '14px', lineHeight: '1.6' }}>{e.candidate_label}</p>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {CHOICES.map(c => (
                  <button
                    key={c.key}
                    className="btn btn-secondary"
                    disabled={pending.has(e.id)}
                    onClick={() => confirm(e.id, c.key)}
                    style={{ height: '28px', fontSize: '12px' }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
