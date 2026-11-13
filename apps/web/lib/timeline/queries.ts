import type { Db } from '@anchor/db'
import { behaviorLogs, dissociationDiary, interventionLogs, stateSegments, sunsetConfig, sunsetSessions } from '@anchor/db'
import { and, eq, gte, gt, isNull, lt, ne, or } from 'drizzle-orm'
import type { UserState } from '@anchor/types'
import { getUserSleepDateStr, userZonedTimeToUtc } from '../time/user-time'

export interface TimelineSegment {
  state: UserState
  start_time: number
  end_time: number
  // realtime=判断引擎实记；backfill=回放补写；session=睡眠会话校准（权威睡眠时间覆盖推断段）
  source: 'realtime' | 'backfill' | 'session'
}

export type TimelineEventKind =
  | 'intervention'
  | 'sleep_start'
  | 'wakeup'
  | 'sleep_confirm'
  | 'curfew_breach'
  | 'curfew_start'

export interface TimelineEventItem {
  time: number
  kind: TimelineEventKind
  title: string
  detail?: string
  level?: 'notify' | 'soft' | 'hard' | 'strong'
  result?: 'executed' | 'dismissed' | 'expired' | null
}

export interface DissociationCandidate {
  id: number
  period_start: number
  period_end: number
  candidate_label: string
  user_choice: string | null
}

export interface TimelineDayData {
  date: string
  segments: TimelineSegment[]
  events: TimelineEventItem[]
  hourly_density: number[] // 24 格，0..1
  hourly_dominant: (UserState | null)[] // 24 格
  // 宵禁窗口（Unix 秒）：起点=配置就寝时间，终点跟随会话（入睡/解除/计划 8h 兜底）；
  // null = 当晚无宵禁（早睡于宵禁 / 宵禁未启用 / 就寝时刻未过）
  curfew_window: { start: number; end: number } | null
  dissociation_candidates: DissociationCandidate[]
  summary: {
    state_seconds: Record<string, number>
    intervention_total: number
    intervention_by_level: Record<string, number>
    sleep_start: number | null
    sleep_end: number | null
  }
}

export interface TimelineDayMini {
  date: string
  has_data: boolean
  strips: Array<{ state: UserState; fraction: number }>
}

const LEVEL_TITLE: Record<string, string> = {
  notify: '通知提醒',
  soft: '软干预',
  hard: '硬干预',
  strong: '强制干预',
}

/** 用户时区当日 00:00 起的 86400 秒 */
export function dayBounds(date: string): { startS: number; endS: number } {
  const startS = userZonedTimeToUtc(date, 0)
  return { startS, endS: startS + 86400 }
}

/** 会话归属夜：与 sleep/engine.sessionDateKey 一致（12:00 前归前一晚）。 */
function sessionNightKey(unixS: number): string {
  return getUserSleepDateStr(unixS * 1000)
}

type SessionRow = typeof sunsetSessions.$inferSelect

/**
 * 会话睡眠窗口（权威睡眠时间）：sleep_start_at → cleared_at；
 * 无 cleared_at 且仍在睡 → 到现在；脏数据兜底 +8h。
 * 睡眠引擎的 sleep_start_at 是回算值（候选起点+缓冲），而判断引擎的 sleeping 段
 * 从相位翻转 tick 才开始写——两者天然差 20~40 分钟，故时间轴以会话窗口为准重绘。
 */
function sleepWindowsFromSessions(sessions: SessionRow[], nowS: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const s of sessions) {
    if (s.sleep_start_at == null) continue
    const start = s.sleep_start_at
    let end: number
    if (s.cleared_at != null && s.cleared_at > start) end = s.cleared_at
    else if (s.phase === 'sleeping' || s.phase === 'wake_observing') end = nowS
    else end = start + 8 * 3600
    if (end > start) out.push({ start, end })
  }
  return out
}

/** 用会话睡眠窗口覆盖分段：窗口内推断段裁掉，替换为 sleeping（source='session'） */
function applySleepWindows(
  segments: TimelineSegment[],
  windows: Array<{ start: number; end: number }>,
  startS: number,
  endS: number,
): TimelineSegment[] {
  let out = segments
  for (const w of windows) {
    const ws = Math.max(w.start, startS)
    const we = Math.min(w.end, endS)
    if (we <= ws) continue
    const next: TimelineSegment[] = []
    for (const s of out) {
      if (s.end_time <= ws || s.start_time >= we) { next.push(s); continue }
      if (s.start_time < ws) next.push({ ...s, end_time: ws })
      if (s.end_time > we) next.push({ ...s, start_time: we })
    }
    next.push({ state: 'sleeping', start_time: ws, end_time: we, source: 'session' })
    next.sort((a, b) => a.start_time - b.start_time)
    out = next
  }
  return out
}

/** 查询与 [startS, endS) 重叠的分段并裁切到边界；open 段闭合到 endS */
function querySegments(db: Db, startS: number, endS: number): TimelineSegment[] {
  const rows = db
    .select()
    .from(stateSegments)
    .where(and(
      lt(stateSegments.started_at, endS),
      or(isNull(stateSegments.ended_at), gt(stateSegments.ended_at, startS)),
    ))
    .orderBy(stateSegments.started_at)
    .all()
  const out: TimelineSegment[] = []
  for (const r of rows) {
    const s = Math.max(r.started_at, startS)
    const e = Math.min(r.ended_at ?? endS, endS)
    if (e <= s) continue
    out.push({ state: r.state as UserState, start_time: s, end_time: e, source: r.source as 'realtime' | 'backfill' })
  }
  return out
}

/** nowS：有效末端（历史日 = dayEnd；今天 = 当前时刻，open 段不延伸到未来） */
export function getTimelineDay(db: Db, date: string, nowS?: number): TimelineDayData {
  const { startS, endS } = dayBounds(date)
  const effEnd = Math.min(endS, nowS ?? Math.floor(Date.now() / 1000))
  const rawSegments = querySegments(db, startS, effEnd)

  // 事件：干预
  const events: TimelineEventItem[] = []
  const ivRows = db
    .select()
    .from(interventionLogs)
    .where(and(gte(interventionLogs.dispatched_at, startS), lt(interventionLogs.dispatched_at, endS)))
    .orderBy(interventionLogs.dispatched_at)
    .all()
  for (const r of ivRows) {
    events.push({
      time: r.dispatched_at,
      kind: 'intervention',
      title: LEVEL_TITLE[r.level] ?? r.level,
      detail: r.trigger_reason ?? undefined,
      level: r.level as TimelineEventItem['level'],
      result: r.result as TimelineEventItem['result'],
    })
  }

  // 事件：睡眠会话标记（字段时间戳落在当日即取，不论 session.date 归属）
  const sessions = db.select().from(sunsetSessions).all()
  let sleepStart: number | null = null
  let sleepEnd: number | null = null
  for (const s of sessions) {
    if (s.sleep_start_at && s.sleep_start_at >= startS && s.sleep_start_at < endS) {
      events.push({ time: s.sleep_start_at, kind: 'sleep_start', title: '入睡' })
      sleepStart = s.sleep_start_at
    }
    if (s.cleared_at && s.cleared_at >= startS && s.cleared_at < endS) {
      const label = s.clear_reason === 'wakeup'
        ? '起床'
        : s.clear_reason === 'school_departure'
          ? '起床（上学估算）'
          : s.clear_reason === 'auto_8h'
            ? '自动解除（8h）'
            : '强制解除'
      events.push({ time: s.cleared_at, kind: 'wakeup', title: label })
      if (s.clear_reason === 'wakeup' || s.clear_reason === 'school_departure') sleepEnd = s.cleared_at
    }
    if (s.confirm_requested_at && s.confirm_requested_at >= startS && s.confirm_requested_at < endS) {
      events.push({ time: s.confirm_requested_at, kind: 'sleep_confirm', title: '睡眠确认弹窗' })
    }
  }

  // 会话睡眠窗口覆盖：sunset_sessions 是睡眠时间的权威（sleep_start 回算值，
  // 判断引擎 sleeping 段从相位翻转 tick 才起写，且历史上有确认抖动留下的假 working 段），
  // 覆盖后 segments 用于渲染与 state_seconds / hourly_dominant 统计
  const segments = applySleepWindows(rawSegments, sleepWindowsFromSessions(sessions, effEnd), startS, effEnd)

  // 事件：宵禁破戒（behavior_logs）
  const breaches = db
    .select({ logged_at: behaviorLogs.logged_at, payload: behaviorLogs.payload })
    .from(behaviorLogs)
    .where(and(
      eq(behaviorLogs.event_type, 'curfew_breach'),
      gte(behaviorLogs.logged_at, startS),
      lt(behaviorLogs.logged_at, endS),
    ))
    .all()
  for (const b of breaches) {
    events.push({ time: b.logged_at, kind: 'curfew_breach', title: '宵禁破戒', detail: '强制解锁' })
  }

  // 宵禁窗口：起点=配置就寝时间；终点跟随该宵禁归属夜的会话——
  //   晚睡（sleep_start > 起点）→ 到入睡为止；
  //   早睡于宵禁（sleep_start ≤ 起点）→ 当晚未进入宵禁，不画；
  //   无入睡 → cleared_at 落在窗口内则用它收尾，否则计划 8h 窗口兜底（含服务器离线无法知晓的夜晚）
  const cfg = db.select().from(sunsetConfig).limit(1).get()
  let curfewWindow: { start: number; end: number } | null = null
  if (cfg?.enabled) {
    const cs = startS + cfg.target_bedtime_minutes * 60
    const session = sessions.find(s => s.date === sessionNightKey(cs)) ?? null
    let ce: number | null = null
    if (session?.sleep_start_at != null) {
      ce = session.sleep_start_at > cs ? session.sleep_start_at : null
    } else {
      const winMax = cs + 8 * 3600
      ce = session?.cleared_at != null && session.cleared_at > cs && session.cleared_at < winMax
        ? session.cleared_at
        : winMax
    }
    if (ce !== null && ce > cs && cs >= startS && cs < effEnd) {
      curfewWindow = { start: cs, end: Math.min(ce, effEnd) }
      events.push({ time: cs, kind: 'curfew_start', title: '宵禁开始' })
    }
  }

  events.sort((a, b) => a.time - b.time)

  // 解离候选（当日开始）
  const candidates = db
    .select()
    .from(dissociationDiary)
    .where(and(gte(dissociationDiary.period_start, startS), lt(dissociationDiary.period_start, endS)))
    .all()
    .map(r => ({
      id: r.id,
      period_start: r.period_start,
      period_end: r.period_end,
      candidate_label: r.candidate_label,
      user_choice: r.user_choice,
    }))

  // 每小时：信号密度（behavior_logs 计数归一化，排除睡眠短路每分钟写的 state_inference 哨兵）+ 主导状态（分段覆盖时长最长）
  const hourly_density = new Array<number>(24).fill(0)
  const dayLogs = db
    .select({ logged_at: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .where(and(
      gte(behaviorLogs.logged_at, startS),
      lt(behaviorLogs.logged_at, effEnd),
      ne(behaviorLogs.event_type, 'state_inference'),
    ))
    .all()
  for (const l of dayLogs) {
    hourly_density[Math.floor((l.logged_at - startS) / 3600)]++
  }
  const maxCount = Math.max(0, ...hourly_density)
  const densityNorm = hourly_density.map(c => (maxCount > 0 ? c / maxCount : 0))

  const hourly_dominant: (UserState | null)[] = new Array<UserState | null>(24).fill(null)
  for (let h = 0; h < 24; h++) {
    const hStart = startS + h * 3600
    const hEnd = hStart + 3600
    const cover = new Map<UserState, number>()
    for (const s of segments) {
      const overlap = Math.min(s.end_time, hEnd) - Math.max(s.start_time, hStart)
      if (overlap > 0) cover.set(s.state, (cover.get(s.state) ?? 0) + overlap)
    }
    let best: UserState | null = null
    let bestSec = 0
    for (const [st, sec] of cover) {
      if (sec > bestSec) { best = st; bestSec = sec }
    }
    hourly_dominant[h] = best
  }

  // 摘要
  const state_seconds: Record<string, number> = {}
  for (const s of segments) {
    state_seconds[s.state] = (state_seconds[s.state] ?? 0) + (s.end_time - s.start_time)
  }
  const intervention_by_level: Record<string, number> = {}
  for (const r of ivRows) {
    intervention_by_level[r.level] = (intervention_by_level[r.level] ?? 0) + 1
  }

  return {
    date,
    segments,
    events,
    hourly_density: densityNorm,
    hourly_dominant,
    curfew_window: curfewWindow,
    dissociation_candidates: candidates,
    summary: {
      state_seconds,
      intervention_total: ivRows.length,
      intervention_by_level,
      sleep_start: sleepStart,
      sleep_end: sleepEnd,
    },
  }
}

/** 日期区间内每日迷你色条（档案卡片架数据源）；同样以会话睡眠窗口校准 */
export function getTimelineDays(db: Db, fromDate: string, toDate: string): TimelineDayMini[] {
  const out: TimelineDayMini[] = []
  const nowS = Math.floor(Date.now() / 1000)
  const sessions = db.select().from(sunsetSessions).all()
  const sleepWins = sleepWindowsFromSessions(sessions, nowS)
  for (let d = fromDate; d <= toDate; d = nextDate(d)) {
    const { startS, endS } = dayBounds(d)
    const effEnd = Math.min(endS, nowS)
    const segments = applySleepWindows(querySegments(db, startS, effEnd), sleepWins, startS, effEnd)
    const strips = segments.map(s => ({
      state: s.state,
      fraction: (s.end_time - s.start_time) / 86400,
    }))
    out.push({ date: d, has_data: strips.length > 0, strips })
  }
  return out
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
