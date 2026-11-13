'use client'

import { useEffect, useState } from 'react'
import type React from 'react'
import { BellOff, Moon, ShieldAlert, ShieldBan, Sunset } from 'lucide-react'
import type { SunsetAnchorMode, SunsetConfig } from '@anchor/types'

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

const PRESETS = [
  { label: '22:30', value: 22 * 60 + 30 },
  { label: '23:00', value: 23 * 60 },
  { label: '23:30', value: 23 * 60 + 30 },
  { label: '00:00', value: 0 },
  { label: '00:30', value: 30 },
  { label: '01:00', value: 60 },
]

const STEPS = [
  { label: '−1 小时', delta: -60 },
  { label: '−5 分钟', delta: -5 },
  { label: '+5 分钟', delta: 5 },
  { label: '+1 小时', delta: 60 },
]

const ANCHOR_MODES: { value: SunsetAnchorMode; label: string; desc: string }[] = [
  { value: 'config_hard', label: '固定宵禁（推荐）', desc: '倒数一律从上方配置时间开始，学习节律不影响' },
  { value: 'adaptive_clamped', label: '自适应·有底线', desc: '跟随学习节律，但不会早于配置时间' },
  { value: 'adaptive_soft', label: '完全自适应', desc: '完全跟随学习节律，上方宵禁时间不生效' },
  { value: 'progressive', label: '渐进调整', desc: '合规时每天提前一步，睡晚时原地等你（锚点领先实际入睡最多 90 分钟）' },
]

export default function SunsetSettingsPage() {
  const [config, setConfig] = useState<SunsetConfig | null>(null)
  const [snapshot, setSnapshot] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/sunset')
      .then(r => r.json())
      .then((cfg: SunsetConfig) => {
        // 旧服务端快照可能缺 anchor_mode / 渐进字段，补默认值后再对比快照，避免假 dirty
        const normalized: SunsetConfig = {
          ...cfg,
          anchor_mode: cfg.anchor_mode ?? 'config_hard',
          ideal_bedtime_minutes: cfg.ideal_bedtime_minutes ?? 23 * 60 + 30,
          progressive_step_minutes: cfg.progressive_step_minutes ?? 15,
        }
        setConfig(normalized)
        setSnapshot(JSON.stringify(normalized))
      })
      .catch(console.error)
  }, [])

  async function save() {
    if (!config) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/sunset', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (res.ok) {
        const updated: SunsetConfig = await res.json()
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
          <h1 className="page-title">数字宵禁</h1>
        </div>
        <div className="skeleton" style={{ height: '56px', borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-8)' }} />
        <div className="skeleton" style={{ height: '160px', borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-8)' }} />
        <div className="skeleton" style={{ height: '220px', borderRadius: 'var(--radius-lg)' }} />
      </div>
    )
  }

  const dirty = JSON.stringify(config) !== snapshot
  const bedtime = config.target_bedtime_minutes
  const step = (delta: number) =>
    setConfig({ ...config, target_bedtime_minutes: (bedtime + delta + DAY_MINUTES) % DAY_MINUTES })

  const phases = [
    { key: 'phase_t60_enabled' as const, offset: 60, icon: BellOff,     label: 'T-60 分钟', desc: '灰度滤镜 + 静默通知' },
    { key: 'phase_t30_enabled' as const, offset: 30, icon: ShieldAlert, label: 'T-30 分钟', desc: '高刺激网站摘要屏蔽' },
    { key: 'phase_t15_enabled' as const, offset: 15, icon: ShieldBan,   label: 'T-15 分钟', desc: '高刺激应用 / 网站硬拦截' },
    { key: 'phase_t0_enabled'  as const, offset: 0,  icon: Moon,        label: 'T-0 就寝时', desc: '确认禁令提醒' },
  ]

  return (
    <div className="page" style={{ maxWidth: '560px' }}>
      <div className="page-header">
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sunset size={18} style={{ color: 'var(--accent)' }} />
          数字宵禁
        </h1>
        <p className="page-subtitle">就寝前逐步降低屏幕刺激，帮助你自然入睡</p>
      </div>

      {/* 主开关 */}
      <div className="section">
        <div className="sunset-card" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>启用宵禁系统</span>
            <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>
              关闭后所有阶段均不生效
            </span>
          </span>
          <Switch
            checked={config.enabled}
            onChange={v => setConfig({ ...config, enabled: v })}
            label="启用宵禁系统"
          />
        </div>
      </div>

      <div className={config.enabled ? '' : 'sunset-disabled'}>
        {/* 目标就寝时间 */}
        <div className="section">
          <p className="section-title">目标就寝时间</p>
          {config.anchor_mode === 'progressive' ? (
            <div className="sunset-card">
              <div className="time-display">{fmt(bedtime)}</div>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                当前锚点 · 由渐进调整自动管理：昨晚在锚点后 30 分钟内入睡则今晚再提前一步；睡晚则原地等你追上来（锚点最多领先实际入睡 90 分钟）
              </p>
            </div>
          ) : (
            <div className={`sunset-card${config.anchor_mode === 'adaptive_soft' ? ' sunset-disabled' : ''}`}>
              <div className="time-display">{fmt(bedtime)}</div>
              <div className="stepper-row">
                {STEPS.map(({ label, delta }) => (
                  <button key={label} className="btn btn-secondary stepper-btn" onClick={() => step(delta)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="preset-row">
                {PRESETS.map(({ label, value }) => (
                  <button
                    key={label}
                    className={`preset-chip${bedtime === value ? ' active' : ''}`}
                    onClick={() => setConfig({ ...config, target_bedtime_minutes: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 渐进调整：理想就寝 + 步幅 */}
        {config.anchor_mode === 'progressive' && (
          <div className="section">
            <p className="section-title">理想就寝（最终目标）</p>
            <div className="sunset-card">
              <div className="time-display">{fmt(config.ideal_bedtime_minutes)}</div>
              <div className="stepper-row">
                {STEPS.map(({ label, delta }) => (
                  <button
                    key={label}
                    className="btn btn-secondary stepper-btn"
                    onClick={() =>
                      setConfig({
                        ...config,
                        ideal_bedtime_minutes: (config.ideal_bedtime_minutes + delta + DAY_MINUTES) % DAY_MINUTES,
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="preset-row">
                {PRESETS.map(({ label, value }) => (
                  <button
                    key={label}
                    className={`preset-chip${config.ideal_bedtime_minutes === value ? ' active' : ''}`}
                    onClick={() => setConfig({ ...config, ideal_bedtime_minutes: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
                <span style={{ flex: 1, fontSize: '13px', color: 'var(--text-secondary)' }}>
                  每日步幅（锚点每天向理想靠近的上限）
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    className="btn btn-secondary stepper-btn"
                    onClick={() =>
                      setConfig({ ...config, progressive_step_minutes: Math.max(5, config.progressive_step_minutes - 5) })
                    }
                  >
                    −5
                  </button>
                  <span style={{ minWidth: '56px', textAlign: 'center', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
                    {config.progressive_step_minutes} 分钟
                  </span>
                  <button
                    className="btn btn-secondary stepper-btn"
                    onClick={() =>
                      setConfig({ ...config, progressive_step_minutes: Math.min(60, config.progressive_step_minutes + 5) })
                    }
                  >
                    +5
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 倒数锚点模式 */}
        <div className="section">
          <p className="section-title">倒数锚点模式</p>
          <div className="sunset-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {ANCHOR_MODES.map(({ value, label, desc }) => (
              <label
                key={value}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
              >
                <input
                  type="radio"
                  name="anchor_mode"
                  checked={config.anchor_mode === value}
                  onChange={() => setConfig({ ...config, anchor_mode: value })}
                />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>{label}</span>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 宵禁阶段时间轴 */}
        <div className="section">
          <p className="section-title">宵禁阶段</p>
          {config.anchor_mode === 'adaptive_soft' && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              完全自适应模式下，各阶段触发时间由学习节律决定，下方时刻仅供参考
            </p>
          )}
          {config.anchor_mode === 'progressive' && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              渐进调整模式下，下方时刻基于当前托管锚点，会随实际入睡情况每日微调
            </p>
          )}
          <div className="phase-timeline">
            {phases.map(({ key, offset, icon: Icon, label, desc }) => {
              const enabled = config[key]
              const triggerAt = (bedtime - offset + DAY_MINUTES) % DAY_MINUTES
              return (
                <div key={key} className={`phase-row${enabled ? ' enabled' : ''}`}>
                  <span className="phase-rail">
                    <span className="phase-dot" />
                  </span>
                  <Icon size={16} className="phase-icon" />
                  <span className="phase-main">
                    <span className="phase-name">{label}</span>
                    <span className="phase-desc">{desc}</span>
                  </span>
                  <span className="phase-time">{fmt(triggerAt)} 触发</span>
                  <Switch
                    checked={enabled}
                    onChange={v => setConfig({ ...config, [key]: v })}
                    label={label}
                  />
                </div>
              )
            })}
          </div>
        </div>

        {/* 高刺激网站：统一由 /apps 页管理 */}
        <div className="section">
          <p className="section-title">高刺激网站</p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            网站分类已统一在 <a href="/apps" style={{ color: 'var(--accent)' }}>应用与网站管理</a> 页维护
          </p>
        </div>

        {/* 睡眠检测参数 */}
        <div className="section">
          <p className="section-title">睡眠检测</p>
          <div className="sunset-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {([
              { key: 'sleep_buffer_minutes' as const, label: '入睡缓冲', desc: '最后活动到判定入睡的缓冲（分钟）', min: 0, max: 60 },
              { key: 'sleep_confirm_minutes' as const, label: '确认窗口', desc: '「睡着了吗」询问框等待时长（分钟）', min: 1, max: 60 },
              { key: 'sleep_candidate_idle_minutes' as const, label: '候选空闲阈值', desc: '无活动多久触发入睡候选（分钟）', min: 5, max: 120 },
              { key: 'sleep_confirm_cooldown_minutes' as const, label: '确认冷却', desc: '候选作废/误判后再次询问的间隔（分钟）', min: 5, max: 120 },
            ]).map(({ key, label, desc, min, max }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>{label}</span>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>{desc}</span>
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    className="btn btn-secondary stepper-btn"
                    onClick={() => setConfig({ ...config, [key]: Math.max(min, config[key] - 5) })}
                  >
                    −5
                  </button>
                  <span style={{ minWidth: '56px', textAlign: 'center', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
                    {config[key]} 分钟
                  </span>
                  <button
                    className="btn btn-secondary stepper-btn"
                    onClick={() => setConfig({ ...config, [key]: Math.min(max, config[key] + 5) })}
                  >
                    +5
                  </button>
                </div>
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
