import type { DailyContext, InferenceResult } from '@anchor/types'
import type { Db } from '@anchor/db'
import { behaviorLogs } from '@anchor/db'
import { and, gte, lt } from 'drizzle-orm'

/** 每个完整 tick 的近似时长（毫秒），用于解离时长累加。
 *  server.ts 的 FULL_TICK_MS 应直接引用此常量，两处保持同步。 */
export const TICK_INTERVAL_MS = 5 * 60 * 1000 // 5 分钟

export function emptyDailyContext(date: string): DailyContext {
  return {
    date,
    deep_work_total_ms: 0,
    work_session_count: 0,
    longest_deep_work_ms: 0,
    dissociation_count: 0,
    dissociation_total_ms: 0,
    first_dissociation_time: undefined,
    interventions_triggered: 0,
    interventions_dismissed: 0,
    interventions_effective: 0,
    android_unlock_count: 0,
    android_screen_on_total_ms: 0,
    work_by_hour: new Array(24).fill(0),
    distraction_by_hour: new Array(24).fill(0),
  }
}

// 纯累加：tick 推断结果 + 当前小时（+ 可选时间戳）→ 新 context
export function accumulate(
  c: DailyContext,
  r: InferenceResult,
  hour: number,
  nowS?: number,
): DailyContext {
  const next: DailyContext = {
    ...c,
    work_by_hour: [...c.work_by_hour],
    distraction_by_hour: [...c.distraction_by_hour],
  }
  const s = r.snapshot

  if (r.state === 'working') {
    next.deep_work_total_ms += s.deep_work_duration_ms
    if (s.deep_work_duration_ms > next.longest_deep_work_ms) {
      next.longest_deep_work_ms = s.deep_work_duration_ms
    }
    if (r.state_changed) next.work_session_count += 1
    if (hour >= 0 && hour < 24) next.work_by_hour[hour] += 1
  }

  if (r.state === 'dissociating') {
    next.dissociation_count += 1
    // 以 TICK_INTERVAL_MS 近似每个解离 tick 的持续时长
    next.dissociation_total_ms += TICK_INTERVAL_MS
    if (next.first_dissociation_time === undefined && nowS !== undefined) {
      next.first_dissociation_time = nowS
    }
    if (hour >= 0 && hour < 24) next.distraction_by_hour[hour] += 1
  }

  return next
}

export function recordIntervention(
  c: DailyContext,
  outcome: { dismissed: boolean; effective: boolean },
): DailyContext {
  return {
    ...c,
    interventions_triggered: c.interventions_triggered + 1,
    interventions_dismissed: c.interventions_dismissed + (outcome.dismissed ? 1 : 0),
    interventions_effective: c.interventions_effective + (outcome.effective ? 1 : 0),
  }
}

// 模块级单例（重启后由 rebuildFromLogs 重建）
let _current: DailyContext | null = null

export function getDailyContext(date: string): DailyContext {
  if (_current === null || _current.date !== date) {
    // 跨日时由调用方先持久化再 resetDailyContext，此处仅兜底初始化
    _current = emptyDailyContext(date)
  }
  return _current
}

export function setDailyContext(c: DailyContext): void {
  _current = c
}

export function resetDailyContext(): void {
  _current = null
}

// 重启后从当日 behavior_logs 重建 DailyContext 的稳定部分（解锁次数/亮屏时长）
// 返回新对象并更新单例（setDailyContext）
export function rebuildFromLogs(db: Db, date: string, dayStartS: number): DailyContext {
  const dayEndS = dayStartS + 24 * 60 * 60 // 次日 00:00，不含
  const c = emptyDailyContext(date)
  const rows = db
    .select({ event_type: behaviorLogs.event_type, payload: behaviorLogs.payload, logged_at: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .where(and(gte(behaviorLogs.logged_at, dayStartS), lt(behaviorLogs.logged_at, dayEndS)))
    .all()

  let maxUnlock = 0
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>
    if (r.event_type === 'screen_unlock' || r.event_type === 'screen_on') {
      const u = Number(p['unlock_count_today'] ?? 0)
      if (u > maxUnlock) maxUnlock = u
    }
  }

  const rebuilt = { ...c, android_unlock_count: maxUnlock }
  setDailyContext(rebuilt)
  return rebuilt
}
