'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { MessageCircle, BookOpen, Settings } from 'lucide-react'
import { useAnchor } from '../components/AnchorProvider'
import { stateColor } from '../components/state-ui'
import { STATE_LABELS } from '@anchor/utils'
import type { CircadianLog } from '@anchor/types'

function formatTime(unixSeconds: number | null): string {
  if (unixSeconds == null) return '—'
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function SleepSparkline({ logs }: { logs: CircadianLog[] }) {
  const recent = logs.slice(-7)
  if (recent.length < 2) return null

  const W = 200, H = 36
  const toMin = (ts: number) => {
    const d = new Date(ts * 1000)
    const m = d.getHours() * 60 + d.getMinutes()
    return m >= 18 * 60 ? m - 24 * 60 : m
  }
  const vals = recent.map(l => (l.sleep_start != null ? toMin(l.sleep_start) : null))
  const valid = vals.filter((v): v is number => v != null)
  if (valid.length < 2) return null

  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const range = max - min || 60

  const pts = recent.map((_, i) => {
    const v = vals[i]
    const x = (i / (recent.length - 1)) * W
    const y = v != null ? H - ((v - min) / range) * (H - 8) - 4 : null
    return { x, y }
  })

  let d = ''
  pts.forEach(({ x, y }) => {
    if (y == null) return
    d += d === '' ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map(({ x, y }, i) =>
        y != null ? <circle key={i} cx={x} cy={y} r="3" fill="var(--accent)" /> : null
      )}
    </svg>
  )
}

export default function Dashboard() {
  const { state, api } = useAnchor()
  const [logs, setLogs] = useState<CircadianLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getCircadian(7)
      .then(result => {
        if (result.ok) setLogs(result.data)
        else setError(result.message)
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [api])

  const todayStr = new Date().toISOString().slice(0, 10)
  const today = logs.find(l => l.date === todayStr) ?? null

  const riskScore = today?.dissociation_risk_score ?? null
  const debtHours = today?.sleep_debt_hours ?? null
  const meals = today?.meals_count ?? null

  const riskColor =
    riskScore == null ? 'var(--text-secondary)'
    : riskScore >= 7 ? 'var(--color-curfew)'
    : riskScore >= 5 ? 'var(--color-soft)'
    : 'var(--color-passive)'

  const debtColor =
    debtHours == null ? 'var(--text-secondary)'
    : debtHours >= 3 ? 'var(--color-curfew)'
    : debtHours >= 1.5 ? 'var(--color-soft)'
    : 'var(--color-passive)'

  const mealsColor =
    meals == null ? 'var(--text-secondary)'
    : meals < 2 ? 'var(--color-soft)'
    : 'var(--color-passive)'

  const dateLabel = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">今日节律</h1>
        <p className="page-subtitle">{dateLabel}</p>
      </div>

      {/* Live WS state */}
      {state.userState && (
        <div className="section">
          <p className="section-title">实时状态</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: state.connected ? 'var(--color-passive)' : 'var(--text-disabled)',
              flexShrink: 0,
            }} />
            <span style={{ fontSize: '16px', fontWeight: 600, color: stateColor(state.userState) }}>
              {STATE_LABELS[state.userState] ?? state.userState}
            </span>
            {state.sunsetPhase !== 'off' && (
              <span className="badge">安年 {state.sunsetPhase}</span>
            )}
          </div>
          {state.lastAiMessage && (
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px' }}>
              Anchor：{state.lastAiMessage}
            </p>
          )}
        </div>
      )}

      <div className="section">
        <p className="section-title">今日状态</p>
        <div className="grid-3">
          <div className="stat-card">
            <p className="label">解离风险</p>
            <p className="value" style={{ color: riskColor }}>
              {riskScore != null ? `${riskScore.toFixed(1)} / 10` : '—'}
            </p>
          </div>
          <div className="stat-card">
            <p className="label">睡眠债务</p>
            <p className="value" style={{ color: debtColor }}>
              {debtHours != null ? `${debtHours.toFixed(1)} h` : '—'}
            </p>
          </div>
          <div className="stat-card">
            <p className="label">今日用餐</p>
            <p className="value" style={{ color: mealsColor }}>
              {meals != null ? `${meals} 次` : '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="section">
        <p className="section-title">7 天入睡趋势</p>
        {loading && <p style={{ color: 'var(--text-secondary)' }}>加载中…</p>}
        {error && <p style={{ color: 'var(--color-curfew)' }}>加载失败：{error}</p>}
        {!loading && !error && (
          <>
            {logs.length >= 2 && (
              <div style={{ marginBottom: '16px' }}>
                <SleepSparkline logs={logs} />
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>入睡</th>
                    <th>起床</th>
                    <th>债务</th>
                    <th>用餐</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-disabled)', padding: '24px' }}>
                        暂无记录
                      </td>
                    </tr>
                  ) : (
                    logs.slice(-7).map(log => (
                      <tr key={log.date}>
                        <td>{log.date}</td>
                        <td>{formatTime(log.sleep_start)}</td>
                        <td>{formatTime(log.sleep_end)}</td>
                        <td style={{ color: log.sleep_debt_hours != null && log.sleep_debt_hours >= 2 ? 'var(--color-soft)' : 'inherit' }}>
                          {log.sleep_debt_hours != null ? `${log.sleep_debt_hours.toFixed(1)} h` : '—'}
                        </td>
                        <td>{log.meals_count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <p className="section-title">快捷入口</p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Link href="/chat" className="btn btn-secondary"><MessageCircle size={14} />对话</Link>
          <Link href="/diary" className="btn btn-secondary"><BookOpen size={14} />日记</Link>
          <Link href="/settings" className="btn btn-secondary"><Settings size={14} />设置</Link>
        </div>
      </div>
    </div>
  )
}
