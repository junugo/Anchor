'use client'

import { useEffect, useState } from 'react'
import { GraduationCap } from 'lucide-react'
import type { SchoolScheduleConfig } from '@anchor/types'

const DAY_MINUTES = 24 * 60

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} aria-label={label} onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" />
      <span className="switch-thumb" />
    </span>
  )
}

// bit0=周一 … bit6=周日
const WEEKDAYS = [
  { bit: 0, label: '一' },
  { bit: 1, label: '二' },
  { bit: 2, label: '三' },
  { bit: 3, label: '四' },
  { bit: 4, label: '五' },
  { bit: 5, label: '六' },
  { bit: 6, label: '日' },
]

function TimeStepper({ label, desc, value, onChange }: { label: string; desc: string; value: number; onChange: (v: number) => void }) {
  const step = (delta: number) => onChange((value + delta + DAY_MINUTES) % DAY_MINUTES)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>{label}</span>
        <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>{desc}</span>
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button className="btn btn-secondary stepper-btn" onClick={() => step(-5)}>−5</button>
        <span style={{ minWidth: '56px', textAlign: 'center', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(value)}
        </span>
        <button className="btn btn-secondary stepper-btn" onClick={() => step(5)}>+5</button>
      </div>
    </div>
  )
}

export default function SchoolSettingsPage() {
  const [config, setConfig] = useState<SchoolScheduleConfig | null>(null)
  const [snapshot, setSnapshot] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [exceptionDate, setExceptionDate] = useState('')
  const [exceptionKind, setExceptionKind] = useState<'off' | 'school'>('off')

  useEffect(() => {
    fetch('/api/school-schedule')
      .then(r => r.json())
      .then((cfg: SchoolScheduleConfig) => {
        setConfig(cfg)
        setSnapshot(JSON.stringify(cfg))
      })
      .catch(console.error)
  }, [])

  async function save() {
    if (!config) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/school-schedule', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (res.ok) {
        const updated: SchoolScheduleConfig = await res.json()
        setConfig(updated)
        setSnapshot(JSON.stringify(updated))
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!config) {
    return (
      <div className="page" style={{ maxWidth: '560px' }}>
        <div className="page-header">
          <h1 className="page-title">学校作息</h1>
        </div>
        <div className="skeleton" style={{ height: '56px', borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-8)' }} />
        <div className="skeleton" style={{ height: '200px', borderRadius: 'var(--radius-lg)' }} />
      </div>
    )
  }

  const dirty = JSON.stringify(config) !== snapshot
  const exceptions = config.exceptions ?? {}
  const exceptionEntries = Object.entries(exceptions).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="page" style={{ maxWidth: '560px' }}>
      <div className="page-header">
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <GraduationCap size={18} style={{ color: 'var(--accent)' }} />
          学校作息
        </h1>
        <p className="page-subtitle">在校时段内无设备信号是预期空白：时间轴记为「在校」，不推断、不干预、不误判睡眠</p>
      </div>

      {/* 主开关 */}
      <div className="section">
        <div className="sunset-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>启用学校作息</span>
            <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>
              关闭后白天无信号回退为「休息中」语义
            </span>
          </span>
          <Switch
            checked={config.enabled}
            onChange={v => setConfig({ ...config, enabled: v })}
            label="启用学校作息"
          />
        </div>
      </div>

      <div className={config.enabled ? '' : 'sunset-disabled'}>
        {/* 上学日 */}
        <div className="section">
          <p className="section-title">上学日</p>
          <div className="sunset-card">
            <div className="preset-row">
              {WEEKDAYS.map(({ bit, label }) => {
                const on = ((config.days_mask >> bit) & 1) === 1
                return (
                  <button
                    key={bit}
                    className={`preset-chip${on ? ' active' : ''}`}
                    onClick={() => setConfig({ ...config, days_mask: config.days_mask ^ (1 << bit) })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* 时刻 */}
        <div className="section">
          <p className="section-title">在校时段</p>
          <div className="sunset-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <TimeStepper
              label="起床估算"
              desc="上学日无起床信号时按此时刻结算睡眠（sleep_end 估算值）"
              value={config.wake_estimate_minute}
              onChange={v => setConfig({ ...config, wake_estimate_minute: v })}
            />
            <TimeStepper
              label="出门"
              desc="此后在校时段开始，无信号记为「在校」"
              value={config.leave_minute}
              onChange={v => setConfig({ ...config, leave_minute: v })}
            />
            <TimeStepper
              label="到家"
              desc="此后恢复正常推断（晚间使用照常观察）"
              value={config.home_minute}
              onChange={v => setConfig({ ...config, home_minute: v })}
            />
          </div>
        </div>

        {/* 学期范围 */}
        <div className="section">
          <p className="section-title">学期范围（可空）</p>
          <div className="sunset-card" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input
              type="date"
              className="input"
              value={config.term_start ?? ''}
              onChange={e => setConfig({ ...config, term_start: e.target.value || null })}
            />
            <span style={{ color: 'var(--text-secondary)' }}>至</span>
            <input
              type="date"
              className="input"
              value={config.term_end ?? ''}
              onChange={e => setConfig({ ...config, term_end: e.target.value || null })}
            />
          </div>
        </div>

        {/* 单日例外 */}
        <div className="section">
          <p className="section-title">单日例外（请假 / 调休）</p>
          <div className="sunset-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="date"
                className="input"
                value={exceptionDate}
                onChange={e => setExceptionDate(e.target.value)}
              />
              <select
                className="input"
                value={exceptionKind}
                onChange={e => setExceptionKind(e.target.value as 'off' | 'school')}
                style={{ width: 'auto' }}
              >
                <option value="off">请假/不上学</option>
                <option value="school">调休上学</option>
              </select>
              <button
                className="btn btn-secondary"
                disabled={!exceptionDate}
                onClick={() => {
                  setConfig({ ...config, exceptions: { ...exceptions, [exceptionDate]: exceptionKind } })
                  setExceptionDate('')
                }}
              >
                添加
              </button>
            </div>
            {exceptionEntries.length === 0 && (
              <span style={{ fontSize: '12px', color: 'var(--text-disabled)' }}>暂无例外</span>
            )}
            {exceptionEntries.map(([date, kind]) => (
              <div key={date} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <span style={{ flex: 1 }}>{date}</span>
                <span style={{ color: kind === 'off' ? 'var(--color-soft)' : 'var(--color-passive)' }}>
                  {kind === 'off' ? '不上学' : '上学'}
                </span>
                <button
                  className="btn btn-secondary stepper-btn"
                  onClick={() => {
                    const next = { ...exceptions }
                    delete next[date]
                    setConfig({ ...config, exceptions: next })
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 保存 */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? '保存中…' : '保存'}
        </button>
        {saved && !dirty && <span style={{ fontSize: '13px', color: 'var(--color-passive)' }}>已保存</span>}
        {!saved && dirty && <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>有未保存的改动</span>}
      </div>
    </div>
  )
}
