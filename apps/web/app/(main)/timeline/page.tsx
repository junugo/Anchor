'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlarmClock, Ban, BedDouble, Bell, ChevronLeft, ChevronRight, HelpCircle, LockOpen, Moon, ZoomOut, Zap } from 'lucide-react'
import { useAnchor } from '@/app/components/AnchorProvider'
import { stateColor } from '@/app/components/state-ui'
import { STATE_LABELS } from '@anchor/utils'
import type { TimelineDayData, TimelineDayMini, TimelineEventItem, TimelineSegment } from '@/lib/timeline/queries'
import type { UserState } from '@anchor/types'

const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_S = 86400

const LEVEL_SHORT: Record<string, string> = { notify: '提醒', soft: '软', hard: '硬', strong: '强' }

function fmtDate(d: Date): string { return d.toLocaleDateString('sv') }
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + n)
  return fmtDate(d)
}
function fmtClock(unixS: number): string {
  const d = new Date(unixS * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fmtHours(sec: number): string { return `${(sec / 3600).toFixed(1)}h` }

/** 分段来源标签（tooltip 共用：状态段 hover 与宵禁层 hover） */
function segSourceLabel(source: TimelineSegment['source']): string {
  return source === 'backfill' ? '回放推断' : source === 'session' ? '睡眠会话校准' : '实时记录'
}

function eventIcon(e: TimelineEventItem) {
  const size = 10
  switch (e.kind) {
    case 'sleep_start': return <Moon size={size} />
    case 'wakeup': return <AlarmClock size={size} />
    case 'sleep_confirm': return <BedDouble size={size} />
    case 'curfew_breach': return <LockOpen size={size} />
    case 'curfew_start': return <Ban size={size} />
    case 'intervention': return e.level === 'hard' || e.level === 'strong' ? <Zap size={size} /> : <Bell size={size} />
    default: return <HelpCircle size={size} />
  }
}

const RESULT_TAG: Record<string, { text: string; cls: string }> = {
  executed: { text: '已执行', cls: 'ok' },
  dismissed: { text: '已划掉', cls: 'warn' },
  expired: { text: '已过期', cls: 'warn' },
}

export default function TimelinePage() {
  const { onWsMessage } = useAnchor()
  const today = fmtDate(new Date())
  const [weekOffset, setWeekOffset] = useState(0) // 0 = 本周
  const [selected, setSelected] = useState(today)
  const [minis, setMinis] = useState<TimelineDayMini[]>([])
  const [day, setDay] = useState<TimelineDayData | null>(null)
  // 缩放窗口（当日秒偏移）；null = 全天
  const [view, setView] = useState<[number, number] | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startView: [number, number] } | null>(null)
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const weekEnd = addDays(today, -weekOffset * 7)
  const weekStart = addDays(weekEnd, -6)
  const isToday = selected === today

  const loadWeek = useCallback(async () => {
    const r = await fetch(`/api/timeline/days?from=${weekStart}&to=${weekEnd}`)
    const j = await r.json()
    setMinis(j.days ?? [])
  }, [weekStart, weekEnd])

  const loadDay = useCallback(async (date: string) => {
    const r = await fetch(`/api/timeline?date=${date}`)
    setDay(await r.json())
  }, [])

  useEffect(() => { loadWeek() }, [loadWeek])
  useEffect(() => { setView(null); loadDay(selected) }, [selected, loadDay])

  // 今天：状态广播后防抖刷新（实时延伸当前段）
  useEffect(() => {
    if (!isToday) return
    return onWsMessage(msg => {
      if (msg.type !== 'state:update') return
      if (refetchTimer.current) clearTimeout(refetchTimer.current)
      refetchTimer.current = setTimeout(() => { loadDay(today); loadWeek() }, 3000)
    })
  }, [isToday, onWsMessage, loadDay, loadWeek, today])

  const dayStartS = day ? Math.floor(new Date(`${day.date}T00:00:00`).getTime() / 1000) : 0
  const [v0, v1] = view ?? [0, DAY_S]
  const span = v1 - v0
  const toPct = (unixS: number) => `${(((unixS - dayStartS) - v0) / span) * 100}%`
  const widthPct = (fromS: number, toS: number) => `${((toS - fromS) / span) * 100}%`
  const visible = (fromS: number, toS: number) => toS - dayStartS > v0 && fromS - dayStartS < v1

  useEffect(() => {
    if (!day) return

    const el = bandRef.current
    if (!el) return

    function onWheel(e: WheelEvent) {
      const wrap = bandRef.current
      if (!wrap) return
      e.preventDefault()
      e.stopPropagation()
      const rect = wrap.getBoundingClientRect()
      const anchorOff = ((e.clientX - rect.left) / rect.width) * span + v0
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      const newSpan = Math.min(DAY_S, Math.max(1800, span * factor))
      let nv0 = anchorOff - ((anchorOff - v0) / span) * newSpan
      nv0 = Math.min(Math.max(0, nv0), DAY_S - newSpan)
      const nv1 = nv0 + newSpan
      setView(newSpan >= DAY_S ? null : [nv0, nv1])
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [day, span, v0])

  function onPointerDown(e: React.PointerEvent) {
    dragRef.current = { startX: e.clientX, startView: [v0, v1] }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current || !bandRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dt = (-dx / bandRef.current.getBoundingClientRect().width) * span
    let nv0 = dragRef.current.startView[0] + dt
    nv0 = Math.min(Math.max(0, nv0), DAY_S - span)
    setView(span >= DAY_S ? null : [nv0, nv0 + span])
  }
  function onPointerUp() { dragRef.current = null }

  const tickHours = [0, 3, 6, 9, 12, 15, 18, 21, 24].filter(h => h * 3600 >= v0 - 1 && h * 3600 <= v1 + 1)

  return (
    <div className="timeline-page">
      <div className="page-header">
        <h1>时间轴</h1>
        <span className="tl-sub">{day ? `${day.date} ${DOW[new Date(`${day.date}T00:00:00`).getDay()]}` : ''}</span>
      </div>

      <div className="archive-shelf">
        <button className="archive-nav" onClick={() => setWeekOffset(o => o + 1)} aria-label="更早一周"><ChevronLeft size={14} /></button>
        {minis.map(m => (
          <button
            key={m.date}
            className={`archive-card${m.date === selected ? ' sel' : ''}${m.has_data ? '' : ' nodata'}`}
            onClick={() => setSelected(m.date)}
          >
            <span className="archive-date">{m.date === today ? '今天' : `${Number(m.date.slice(5, 7))}/${Number(m.date.slice(8, 10))}`}</span>
            <span className="archive-dow">{DOW[new Date(`${m.date}T00:00:00`).getDay()]}</span>
            <span className="archive-mini">
              {m.strips.map((s, i) => (
                <i key={i} style={{ width: `${s.fraction * 100}%`, background: stateColor(s.state) }} />
              ))}
            </span>
          </button>
        ))}
        <button className="archive-nav" onClick={() => setWeekOffset(o => Math.max(0, o - 1))} disabled={weekOffset === 0} aria-label="更晚一周"><ChevronRight size={14} /></button>
      </div>

      {!day ? <div className="empty-state">加载中…</div> : (
        <div className="tl-cols">
          <div className="tl-main">
            <div className="panel tl-band-panel">
              <div className="tl-panel-title">
                状态色带 · 24h
                {view && <button className="tl-zoomout" onClick={() => setView(null)}><ZoomOut size={12} /> 全天</button>}
              </div>
              <div
                className="tl-band-wrap"
                ref={bandRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => { onPointerUp(); setTip(null) }}
              >
                <div className="tl-band">
                  {day.segments.filter(s => visible(s.start_time, s.end_time)).map((s, i) => (
                    <div
                      key={i}
                      className="tl-seg"
                      style={{ left: toPct(s.start_time), width: widthPct(s.start_time, s.end_time), background: stateColor(s.state) }}
                      onMouseMove={e => setTip({
                        x: e.clientX, y: e.clientY,
                        lines: [STATE_LABELS[s.state], `${fmtClock(s.start_time)} – ${fmtClock(s.end_time)}`, segSourceLabel(s.source)],
                      })}
                    />
                  ))}
                  {day.curfew_window && (() => {
                    const { start: cs, end: ce } = day.curfew_window
                    if (!visible(cs, ce)) return null
                    const from = Math.max(cs, dayStartS + v0)
                    const to = Math.min(ce, dayStartS + v1)
                    return (
                      <div
                        className="tl-curfew"
                        style={{ left: toPct(from), width: widthPct(from, to) }}
                        onMouseMove={e => {
                          // 宵禁层接管 hover：光标横向比例 → hover 时刻（缩放裁剪区间内映射），
                          // tooltip 合并展示宵禁窗口 + 该时刻所在状态段（拖拽/滚轮经冒泡走 wrap 既有处理）
                          const rect = e.currentTarget.getBoundingClientRect()
                          const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
                          const hoverT = from + frac * (to - from)
                          const seg = day.segments.find(s => hoverT >= s.start_time && hoverT < s.end_time)
                          const lines = [`宵禁 ${fmtClock(cs)} – ${fmtClock(ce)}`]
                          if (seg) {
                            lines.push(`${STATE_LABELS[seg.state]} ${fmtClock(seg.start_time)} – ${fmtClock(seg.end_time)}`)
                            lines.push(segSourceLabel(seg.source))
                          }
                          setTip({ x: e.clientX, y: e.clientY, lines })
                        }}
                      />
                    )
                  })()}
                </div>
                <div className="tl-hours">
                  {tickHours.map(h => <span key={h}>{h}</span>)}
                </div>
                <div className="tl-density">
                  {day.hourly_density.map((d, h) => (
                    <i key={h} style={{
                      background: day.hourly_dominant[h] ? stateColor(day.hourly_dominant[h]) : 'var(--text-disabled)',
                      opacity: 0.25 + d * 0.75,
                    }} />
                  ))}
                </div>
                <div className="tl-density-cap">每小时信号密度（透明度 = 行为事件量）</div>
                <div className="tl-events-row">
                  {day.events.filter(e => visible(e.time, e.time + 1)).map((e, i) => (
                    <div
                      key={i}
                      className={`tl-ev k-${e.kind}`}
                      style={{ left: toPct(e.time) }}
                      onMouseMove={ev => setTip({ x: ev.clientX, y: ev.clientY, lines: [e.title, fmtClock(e.time), e.detail ?? ''] })}
                    >
                      {eventIcon(e)}
                    </div>
                  ))}
                </div>
                {tip && (
                  <div className="tl-tip" style={{ left: tip.x + 12, top: tip.y - 10, position: 'fixed' }}>
                    {tip.lines.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                )}
              </div>
              <div className="tl-legend">
                {(['working', 'resting', 'entertaining', 'dissociating', 'sleeping', 'away'] as UserState[]).map(s => (
                  <span key={s}><i style={{ background: stateColor(s) }} />{STATE_LABELS[s]}</span>
                ))}
                {day.curfew_window && (
                  <span className="curfew"><i />宵禁</span>
                )}
                <span className="tl-legend-hint">滚轮缩放 · 拖拽平移 · hover 看详情</span>
              </div>
            </div>

            <div className="panel">
              <div className="tl-panel-title">事件流水 · {day.events.length} 条</div>
              <div className="tl-feed">
                {day.events.length === 0 && <div className="empty-state">当日无事件</div>}
                {day.events.map((e, i) => (
                  <div key={i} className="tl-feed-row">
                    <span className="tl-feed-time">{fmtClock(e.time)}</span>
                    <span className={`tl-feed-ico k-${e.kind}`}>{eventIcon(e)}</span>
                    <span className="tl-feed-text">
                      {e.title}
                      {e.detail && <em>{e.detail}</em>}
                      {e.result && RESULT_TAG[e.result] && <span className={`tl-tag ${RESULT_TAG[e.result].cls}`}>{RESULT_TAG[e.result].text}</span>}
                      {e.kind === 'curfew_breach' && <span className="tl-tag bad">破戒</span>}
                      {e.kind === 'intervention' && (e.level === 'hard' || e.level === 'strong') && <span className="tl-tag bad">硬干预</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="tl-side">
            <div className="panel">
              <div className="tl-panel-title">当日摘要</div>
              {(['working', 'entertaining', 'resting', 'dissociating', 'sleeping', 'away'] as UserState[]).map(s => (
                day.summary.state_seconds[s] ? (
                  <div key={s} className="tl-stat-row">
                    <span>{STATE_LABELS[s]}</span>
                    <b style={{ color: stateColor(s) }}>{fmtHours(day.summary.state_seconds[s])}</b>
                  </div>
                ) : null
              ))}
              <div className="tl-stat-row">
                <span>干预</span>
                <b>{day.summary.intervention_total} 次{day.summary.intervention_total > 0 && ` · ${Object.entries(day.summary.intervention_by_level).map(([l, n]) => `${n} ${LEVEL_SHORT[l] ?? l}`).join(' ')}`}</b>
              </div>
            </div>

            <div className="panel">
              <div className="tl-panel-title">状态分布</div>
              <div className="tl-distbar">
                {(['sleeping', 'working', 'entertaining', 'resting', 'dissociating', 'away'] as UserState[]).map(s => {
                  const sec = day.summary.state_seconds[s] ?? 0
                  if (sec === 0) return null
                  return <i key={s} style={{ width: `${(sec / DAY_S) * 100}%`, background: stateColor(s) }} />
                })}
                <i className="tl-distbar-gap" style={{ width: `${Math.max(0, (1 - Object.values(day.summary.state_seconds).reduce((a, b) => a + b, 0) / DAY_S)) * 100}%` }} />
              </div>
              <div className="tl-dist-legend">
                {(['sleeping', 'working', 'entertaining', 'resting', 'away'] as UserState[]).map(s => {
                  const sec = day.summary.state_seconds[s] ?? 0
                  if (sec === 0) return null
                  return <span key={s}><i style={{ background: stateColor(s) }} />{STATE_LABELS[s]} {Math.round((sec / DAY_S) * 100)}%</span>
                })}
                <span><i className="tl-distbar-gap-i" />无数据 {Math.max(0, Math.round((1 - Object.values(day.summary.state_seconds).reduce((a, b) => a + b, 0) / DAY_S) * 100))}%</span>
              </div>
            </div>

            <div className="panel">
              <div className="tl-panel-title">睡眠会话</div>
              {day.summary.sleep_start ? (
                <>
                  <div className="tl-sleep-flow">
                    <span className="tl-node">入睡 {fmtClock(day.summary.sleep_start)}</span>
                    {day.summary.sleep_end && <>→<span className="tl-node">起床 {fmtClock(day.summary.sleep_end)}</span></>}
                  </div>
                  {day.events.some(e => e.kind === 'curfew_breach') && (
                    <div className="tl-stat-row"><span>宵禁破戒</span><b style={{ color: 'var(--color-curfew)' }}>{day.events.filter(e => e.kind === 'curfew_breach').length} 次</b></div>
                  )}
                  {day.events.filter(e => e.kind === 'sleep_confirm').map((e, i) => (
                    <div key={i} className="tl-stat-row"><span>睡眠确认</span><b>{fmtClock(e.time)}</b></div>
                  ))}
                </>
              ) : <div className="empty-state">当日无睡眠记录</div>}
            </div>

            {day.dissociation_candidates.length > 0 && (
              <div className="panel">
                <div className="tl-panel-title">解离候选</div>
                {day.dissociation_candidates.map(c => (
                  <div key={c.id}>
                    <div className="tl-stat-row">
                      <span>{fmtClock(c.period_start)} – {fmtClock(c.period_end)}</span>
                      <b style={{ color: 'var(--color-curfew)' }}>{Math.round((c.period_end - c.period_start) / 60)} 分钟</b>
                    </div>
                    <div className="tl-candidate">
                      {c.candidate_label}
                      {!c.user_choice && <Link href="/diary" className="tl-btn-mini">去确认</Link>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
