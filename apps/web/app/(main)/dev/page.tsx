'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { useAnchor } from '../../components/AnchorProvider'
import { stateColor } from '../../components/state-ui'
import { STATE_LABELS } from '@anchor/utils'
import type { WsServerMessage, InferenceResult } from '@anchor/types'

// ---- 类型 ----
interface SignalRow {
  id: number
  source: string
  event_type: string
  payload: Record<string, unknown>
  logged_at: number
}

interface CooldownRow {
  key: string
  last_triggered_at: number
}

interface InferenceTick {
  mode: 'full' | 'lightweight'
  result: InferenceResult
  at: number
}

interface DecisionRow {
  action: string
  level: string
  message: string
  at: number
}

// ---- 常量 ----
const SOURCE_COLORS: Record<string, string> = {
  desktop: '#2563eb',
  chrome:  '#16a34a',
  vscode:  '#7c3aed',
  android: '#ea580c',
  web:     '#6b7280',
  manual:  '#6b7280',
}

const COOLDOWN_S = 300 // 5min 默认冷却

const LEVEL_COLORS: Record<string, string> = {
  notify: 'var(--color-passive)',
  soft:   'var(--color-soft)',
  hard:   'var(--accent)',
  strong: 'var(--color-curfew)',
}

function sourceColor(src: string): string {
  return SOURCE_COLORS[src] ?? '#6b7280'
}

function payloadText(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return ''
  }
}

function formatTime(unix: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function cooldownRemaining(lastAt: number, now: number): string {
  const elapsed = now - lastAt
  const remaining = COOLDOWN_S - elapsed
  if (remaining <= 0) return '可触发'
  const m = Math.floor(remaining / 60)
  const s = remaining % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ---- 页面 ----
export default function DevPage() {
  const { state, onWsMessage } = useAnchor()

  const [signals, setSignals] = useState<SignalRow[]>([])
  const [cooldowns, setCooldowns] = useState<CooldownRow[]>([])
  const [cooldownNow, setCooldownNow] = useState(Math.floor(Date.now() / 1000))
  const [confidence, setConfidence] = useState<number | null>(null)
  const [lastStateAt, setLastStateAt] = useState<number | null>(null)
  const [wsSignalCount, setWsSignalCount] = useState(0)
  const [ticks, setTicks] = useState<InferenceTick[]>([])
  const [decisions, setDecisions] = useState<DecisionRow[]>([])
  const seenIdsRef = useRef(new Set<number>())

  // 拉历史信号
  const fetchSignals = useCallback(() => {
    fetch('/api/dev/signals')
      .then(r => r.json())
      .then((data: { signals: SignalRow[] }) => {
        setSignals(data.signals.slice(0, 200))
        data.signals.forEach(s => seenIdsRef.current.add(s.id))
      })
      .catch(console.error)
  }, [])

  useEffect(() => { fetchSignals() }, [fetchSignals])

  // 初始化：拉冷却状态
  const fetchCooldowns = useCallback(() => {
    fetch('/api/dev/cooldowns')
      .then(r => r.json())
      .then((data: { cooldowns: CooldownRow[]; now: number }) => {
        setCooldowns(data.cooldowns.sort((a, b) => b.last_triggered_at - a.last_triggered_at))
        setCooldownNow(data.now)
      })
      .catch(console.error)
  }, [])

  useEffect(() => { fetchCooldowns() }, [fetchCooldowns])

  // 每秒更新倒计时时钟
  useEffect(() => {
    const t = setInterval(() => setCooldownNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  // WS 消息监听
  useEffect(() => {
    const unsub = onWsMessage((msg: WsServerMessage) => {
      if (msg.type === 'dev:signal') {
        const row: SignalRow = {
          id: msg.logged_at * 1000 + Math.random(), // 临时 id（WS 推送无 DB id）
          source: msg.source,
          event_type: msg.event_type,
          payload: msg.payload,
          logged_at: msg.logged_at,
        }
        setWsSignalCount(c => c + 1)
        setSignals(prev => [row, ...prev].slice(0, 200))
      }
      if (msg.type === 'state:update') {
        setConfidence(msg.confidence)
        setLastStateAt(Math.floor(Date.now() / 1000))
        fetchCooldowns()
      }
      if (msg.type === 'dev:inference') {
        setTicks(prev => [{ mode: msg.mode, result: msg.result, at: msg.at }, ...prev].slice(0, 50))
        fetchCooldowns()
      }
      if (msg.type === 'dev:decision') {
        setDecisions(prev => [{ action: msg.action, level: msg.level, message: msg.message, at: msg.at }, ...prev].slice(0, 50))
      }
    })
    return unsub
  }, [onWsMessage, fetchCooldowns])

  const inferredState = state.userState
  const latestTick = ticks[0]
  const historyTicks = ticks.slice(1)

  return (
    <div className="dev-shell">

      {/* 顶部状态条 */}
      <header className="dev-topbar">
        <span className="dev-topbar-title">
          <Terminal size={16} />
          信号监控
        </span>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '12px',
          color: state.connected ? 'var(--color-passive)' : 'var(--text-disabled)',
        }}>
          {state.connected
            ? <><Wifi size={13} /> WS 已连接</>
            : <><WifiOff size={13} /> WS 断开</>}
        </span>

        <div style={{ flex: 1 }} />

        <div className="dev-topbar-stat">
          <span className="stat-label">推断状态</span>
          <span className="stat-value" style={{ color: inferredState ? stateColor(inferredState) : 'var(--text-disabled)' }}>
            {inferredState ? (STATE_LABELS[inferredState] ?? inferredState) : '等待推断…'}
          </span>
        </div>
        <div className="dev-topbar-stat">
          <span className="stat-label">置信度</span>
          <span className="stat-value">
            {confidence !== null ? `${(confidence * 100).toFixed(0)}%` : '—'}
          </span>
        </div>
        <div className="dev-topbar-stat">
          <span className="stat-label">上次更新</span>
          <span className="stat-value" style={{ fontFamily: 'monospace', fontWeight: 500 }}>
            {lastStateAt ? formatTime(lastStateAt) : '—'}
          </span>
        </div>
        <div className="dev-topbar-stat">
          <span className="stat-label">WS 推入信号</span>
          <span className="stat-value" style={{ fontFamily: 'monospace', fontWeight: 500 }}>
            {wsSignalCount}
          </span>
        </div>
      </header>

      <div className="dev-grid">

        {/* 左栏：实时信号流 */}
        <section className="dev-panel">
          <div className="dev-panel-header">
            <p className="dev-panel-title">实时信号流</p>
            <span style={{ fontSize: '11px', color: 'var(--text-disabled)' }}>
              {signals.length} 条
            </span>
            <button
              onClick={fetchSignals}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px', marginLeft: 'auto' }}
              title="刷新"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="dev-panel-scroll">
            {signals.length === 0 && (
              <p style={{ color: 'var(--text-disabled)', fontSize: '13px', padding: '12px 0' }}>暂无信号记录</p>
            )}
            {signals.map((sig, i) => {
              const payload = payloadText(sig.payload)
              return (
                <div key={`${sig.id}-${i}`} className="dev-log-row">
                  <span className="dev-log-time">{formatTime(sig.logged_at)}</span>
                  <span>
                    <span
                      className="dev-badge"
                      style={{ background: sourceColor(sig.source) + '22', color: sourceColor(sig.source) }}
                    >
                      {sig.source}
                    </span>
                  </span>
                  <span className="dev-log-type">{sig.event_type}</span>
                  <span className="dev-log-payload" title={payload}>{payload}</span>
                </div>
              )
            })}
          </div>
        </section>

        {/* 右栏 */}
        <aside className="dev-side">

          {/* 推断过程 */}
          <section className="dev-panel" style={{ flex: '0 0 auto', maxHeight: '55%' }}>
            <div className="dev-panel-header">
              <p className="dev-panel-title">推断过程</p>
              {latestTick && (
                <span style={{ fontSize: '11px', color: 'var(--text-disabled)', marginLeft: 'auto' }}>
                  {ticks.length} 次 tick
                </span>
              )}
            </div>
            <div className="dev-panel-scroll">
              {ticks.length === 0 ? (
                <p style={{ color: 'var(--text-disabled)', fontSize: '13px' }}>等待 pipeline tick…</p>
              ) : (
                <>
                  {/* 最新 tick：完整展开 */}
                  {latestTick && (
                    <div style={{ fontSize: '12px', paddingBottom: '8px', borderBottom: '1px solid var(--border)', marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                        <span
                          className="dev-badge"
                          style={latestTick.mode === 'full'
                            ? { background: 'var(--accent)' + '22', color: 'var(--accent)' }
                            : { background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                        >
                          {latestTick.mode}
                        </span>
                        <span style={{ fontWeight: 700, color: stateColor(latestTick.result.state) }}>
                          {STATE_LABELS[latestTick.result.state] ?? latestTick.result.state}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {(latestTick.result.confidence * 100).toFixed(0)}%
                        </span>
                        {latestTick.result.needs_ai_arbitration && (
                          <span style={{ fontSize: '10px', color: 'var(--color-soft)', fontWeight: 600 }}>AI 仲裁</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: 'var(--text-disabled)' }}>
                          {formatTime(latestTick.at)}
                        </span>
                      </div>
                      {latestTick.result.candidates && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '6px' }}>
                          {latestTick.result.candidates.map(c => (
                            <div key={c.state} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ width: '48px', color: 'var(--text-secondary)', flexShrink: 0 }}>
                                {STATE_LABELS[c.state] ?? c.state}
                              </span>
                              <div style={{ flex: 1, height: '4px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden' }}>
                                <div style={{
                                  width: `${Math.round(c.score * 100)}%`,
                                  height: '100%',
                                  background: c.state === latestTick.result.state ? stateColor(c.state) : 'var(--text-disabled)',
                                }} />
                              </div>
                              <span style={{ width: '32px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-disabled)', flexShrink: 0 }}>
                                {c.score.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ color: 'var(--text-disabled)', fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '11px' }}>
                        {latestTick.result.evidence.join(' · ')}
                      </div>
                    </div>
                  )}
                  {/* 历史 tick：单行压缩 */}
                  {historyTicks.map((tick, i) => (
                    <div
                      key={`${tick.at}-${i}`}
                      className="dev-log-row"
                      style={{ gridTemplateColumns: 'auto auto auto 1fr auto', fontFamily: 'inherit' }}
                    >
                      <span
                        className="dev-badge"
                        style={tick.mode === 'full'
                          ? { background: 'var(--accent)' + '22', color: 'var(--accent)' }
                          : { background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        {tick.mode === 'full' ? 'F' : 'L'}
                      </span>
                      <span style={{ fontWeight: 600, color: stateColor(tick.result.state), fontSize: '12px' }}>
                        {STATE_LABELS[tick.result.state] ?? tick.result.state}
                      </span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {(tick.result.confidence * 100).toFixed(0)}%
                      </span>
                      <span style={{ color: 'var(--text-disabled)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tick.result.needs_ai_arbitration ? 'AI 仲裁' : ''}
                      </span>
                      <span className="dev-log-time">{formatTime(tick.at)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>

          {/* 决策触发 */}
          <section className="dev-panel" style={{ flex: '0 0 auto', maxHeight: '22%' }}>
            <div className="dev-panel-header">
              <p className="dev-panel-title">决策触发</p>
            </div>
            <div className="dev-panel-scroll">
              {decisions.length === 0 ? (
                <p style={{ color: 'var(--text-disabled)', fontSize: '13px' }}>暂无触发的干预</p>
              ) : (
                decisions.map((d, i) => (
                  <div key={`${d.at}-${i}`} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        className="dev-badge"
                        style={{ color: LEVEL_COLORS[d.level] ?? 'var(--text-secondary)', border: `1px solid ${LEVEL_COLORS[d.level] ?? 'var(--border)'}` }}
                      >
                        {d.level}
                      </span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{d.action}</span>
                      <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: 'var(--text-disabled)' }}>{formatTime(d.at)}</span>
                    </div>
                    {d.message && (
                      <p style={{ margin: '2px 0 0', color: 'var(--text-secondary)' }}>{d.message}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 决策冷却 */}
          <section className="dev-panel" style={{ flex: '1 1 auto' }}>
            <div className="dev-panel-header">
              <p className="dev-panel-title">决策冷却</p>
              <button
                onClick={fetchCooldowns}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px', marginLeft: 'auto' }}
                title="刷新"
              >
                <RefreshCw size={12} />
              </button>
            </div>
            <div className="dev-panel-scroll">
              {cooldowns.length === 0 ? (
                <p style={{ color: 'var(--text-disabled)', fontSize: '13px' }}>暂无冷却记录</p>
              ) : (
                <table className="dev-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>上次触发</th>
                      <th style={{ textAlign: 'right' }}>剩余</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cooldowns.map(cd => {
                      const remaining = cooldownRemaining(cd.last_triggered_at, cooldownNow)
                      const isReady = remaining === '可触发'
                      return (
                        <tr key={cd.key}>
                          <td style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{cd.key}</td>
                          <td style={{ fontFamily: 'monospace' }}>{formatTime(cd.last_triggered_at)}</td>
                          <td style={{
                            textAlign: 'right',
                            fontWeight: isReady ? 600 : 400,
                            color: isReady ? 'var(--color-passive)' : 'var(--text-secondary)',
                            fontFamily: 'monospace',
                          }}>
                            {remaining}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

        </aside>
      </div>
    </div>
  )
}
