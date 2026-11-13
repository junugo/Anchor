/**
 * 状态分段回放推断：重放 behavior_logs，按小时窗口跑 extractFeatures + inferState
 * （纯函数），补写 source='backfill' 的 state_segments。
 *
 * 用途：
 * - 一次性历史回填（scripts/backfill-state-segments.ts，薄壳）
 * - 服务器离线后客户端 /api/ingest/batch 补发 → 缺口回填（ingest/batch/route.ts 钩子）
 *
 * 规则：
 * - realtime 段（服务器在线期的权威数据）不动；只回放它们之间/之前的空档
 * - 空档内的旧 backfill 段先删后重建（幂等）
 * - 含睡眠哨兵日志（state_inference/sleeping）的小时直接判 sleeping
 * - 零事件小时不留段（页面显示「无数据」灰），而非猜 resting
 * - _running 守卫防并发回放（batch 连续到达）
 */
import type { Db } from '@anchor/db'
import { behaviorLogs, stateSegments, sunsetConfig } from '@anchor/db'
import { and, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm'
import type { ExtractorConfig, LogEntry, UserState } from '@anchor/types'
import { extractFeatures } from '../inference/feature-extractor'
import { inferState } from '../inference/state-inferrer'
import { DEV_TOOLS } from '../decision/engine'
import { getHighStimulusSites } from '../sites/high-stimulus'
import { getWorkApps, getWorkProcesses, getWorkSites } from '../sites/work'
import { loadMemory } from '../memory/memory-loader'
import { getSchoolContext } from '../school/schedule'
import { getUserHour } from '../time/user-time'

const HOUR = 3600

let _running = false

/** 测试专用：重置并发守卫 */
export function resetReplayGuard(): void {
  _running = false
}

export interface ReplayResult {
  hours: number // 扫描的小时数
  written: number // 写入的 backfill 段数
}

export function replayStateSegments(db: Db, fromS: number, toS: number): ReplayResult {
  if (_running) return { hours: 0, written: 0 }
  _running = true
  try {
    return doReplay(db, fromS, toS)
  } finally {
    _running = false
  }
}

function doReplay(db: Db, fromS: number, toS: number): ReplayResult {
  const fromH = Math.floor(fromS / HOUR) * HOUR
  if (fromH >= toS) return { hours: 0, written: 0 }

  // 空档 = [fromH, toS) 减去 realtime 段覆盖区间
  const rts = db
    .select()
    .from(stateSegments)
    .where(and(
      eq(stateSegments.source, 'realtime'),
      lt(stateSegments.started_at, toS),
      or(isNull(stateSegments.ended_at), gt(stateSegments.ended_at, fromH)),
    ))
    .orderBy(stateSegments.started_at)
    .all()
  const gaps: Array<[number, number]> = []
  let cursor = fromH
  for (const rt of rts) {
    const rs = Math.max(rt.started_at, fromH)
    const re = Math.min(rt.ended_at ?? toS, toS)
    if (rs > cursor) gaps.push([cursor, rs])
    cursor = Math.max(cursor, re)
  }
  if (cursor < toS) gaps.push([cursor, toS])
  if (gaps.length === 0) return { hours: 0, written: 0 }

  // 推断配置（与 pipeline 同源）
  const cfgRow = db.select().from(sunsetConfig).limit(1).get()
  const config: ExtractorConfig = {
    highStimulusDomains: getHighStimulusSites(db),
    highStimulusApps: (cfgRow?.high_stimulus_apps as string[] | undefined) ?? [],
    devToolProcesses: DEV_TOOLS,
    workDomains: getWorkSites(db),
    workApps: getWorkApps(db),
    workProcesses: getWorkProcesses(db),
  }
  const memory = loadMemory(db)

  let hours = 0
  let written = 0

  for (const [g0, g1] of gaps) {
    // 幂等：清除空档内旧 backfill 段
    db.delete(stateSegments)
      .where(and(
        eq(stateSegments.source, 'backfill'),
        lt(stateSegments.started_at, g1),
        or(isNull(stateSegments.ended_at), gt(stateSegments.ended_at, g0)),
      ))
      .run()

    // prevState 种子：空档前最近一段的状态（sleeping 归一为 resting，同 pipeline 恢复段）
    const prevSeg = db
      .select({ state: stateSegments.state })
      .from(stateSegments)
      .where(lt(stateSegments.started_at, g0))
      .orderBy(desc(stateSegments.started_at))
      .limit(1)
      .get()
    let prevState: UserState = (prevSeg?.state as UserState | undefined) ?? 'resting'
    if (prevState === 'sleeping') prevState = 'resting'

    let curState: UserState | null = null
    let curStart = 0
    const flush = (endS: number) => {
      if (curState === null) return
      const s = Math.max(curStart, g0)
      const e = Math.min(endS, g1)
      if (e > s) {
        db.insert(stateSegments)
          .values({ state: curState, started_at: s, ended_at: e, source: 'backfill' })
          .run()
        written++
      }
    }

    for (let h = Math.floor(g0 / HOUR) * HOUR; h < g1; h += HOUR) {
      hours++
      // 睡眠哨兵优先（判断引擎短路期间的权威状态）
      const sentinel = db
        .select({ c: sql<number>`count(*)` })
        .from(behaviorLogs)
        .where(and(
          gte(behaviorLogs.logged_at, h),
          lt(behaviorLogs.logged_at, h + HOUR),
          eq(behaviorLogs.event_type, 'state_inference'),
          eq(behaviorLogs.inferred_state, 'sleeping'),
        ))
        .get()

      let state: UserState | null
      if ((sentinel?.c ?? 0) > 0) {
        state = 'sleeping'
      } else {
        const rows = db
          .select({ source: behaviorLogs.source, event_type: behaviorLogs.event_type, payload: behaviorLogs.payload, logged_at: behaviorLogs.logged_at })
          .from(behaviorLogs)
          .where(and(gte(behaviorLogs.logged_at, h - 2 * HOUR), lt(behaviorLogs.logged_at, h + HOUR)))
          .orderBy(desc(behaviorLogs.logged_at))
          .all()
        const hourLogs = rows.filter(r => r.logged_at >= h)
        if (hourLogs.length === 0) {
          // 零事件小时：默认无数据；落在启用的上学日程校时段内 → away（预期空白）
          const school = getSchoolContext(db, (h + HOUR / 2) * 1000)
          state = school?.inSchoolHours ? 'away' : null
        } else {
          const logs: LogEntry[] = rows.map(r => ({
            source: r.source,
            event_type: r.event_type as LogEntry['event_type'],
            payload: r.payload as Record<string, unknown>,
            logged_at: r.logged_at,
          }))
          const snapshot = extractFeatures(logs, (h + HOUR) * 1000, { isLightweight: false, config })
          state = inferState(snapshot, {
            previousState: prevState,
            memory,
            nowHour: getUserHour((h + HOUR) * 1000),
          }).state
          prevState = state === 'sleeping' ? 'resting' : state
        }
      }

      if (state !== curState) {
        flush(h)
        curState = state
        curStart = h
      }
    }
    flush(g1)
  }

  return { hours, written }
}
