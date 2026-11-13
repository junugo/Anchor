import type { Db } from '@anchor/db'
import { circadianLogs, behaviorLogs } from '@anchor/db'
import { eq, gte, lt, and } from 'drizzle-orm'
import { getSunsetConfig } from '../sunset/config'
import {
  chaseCandidateMinutes,
  loadLastSleepStart,
  loadNightMedianSleepStart,
  signedDelta,
  GRACE_MINUTES,
} from '../sunset/progressive'
import { getUserMinutesSinceMidnight, userZonedTimeToUtc } from '../time/user-time'

const TARGET_SLEEP_HOURS = 8

/**
 * Called when sleep_end is recorded. Computes sleep_debt_hours and
 * dissociation_risk_score and writes them back to today's circadian_logs row.
 */
export function updateSleepMetrics(db: Db, today: string): void {
  const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  if (!row || !row.sleep_end) return

  let debtHours = 0
  if (row.sleep_start) {
    const sleptSeconds = row.sleep_end - row.sleep_start
    const sleptHours = sleptSeconds / 3600
    debtHours = Math.max(0, TARGET_SLEEP_HOURS - sleptHours)
  }

  const riskScore = computeDissociationRisk(db, today)

  db.update(circadianLogs)
    .set({ sleep_debt_hours: debtHours, dissociation_risk_score: riskScore })
    .where(eq(circadianLogs.date, today))
    .run()
}

/**
 * Returns suggested bedtime in minutes-from-midnight for tonight.
 *
 * progressive 模式下镜像领走引擎（lib/sunset/progressive.ts）的语义：
 * 昨晚合规（入睡 ≤ 锚点+宽限）或数据不足 → 锚点再向 ideal 领走一步；
 * 睡晚 → 今晚目标即当前锚点（原地施压等待）。其他模式退回跟随式建议：
 * 近 7 晚入睡中位数朝 ideal 偏移一步；无足够历史回退当前配置锚点。
 *
 * 只统计夜间入睡（18:00–10:00）：白天时段的 sleep_start 是 phantom sleeping /
 * 上学日误判的产物，会把目标拉偏（2026-09 开学周实测漂到 05:25 的事故）。
 */
export function computeProgressiveBedtime(db: Db): number {
  const config = getSunsetConfig()
  const ideal = config.ideal_bedtime_minutes
  const step = config.progressive_step_minutes
  const anchor = config.target_bedtime_minutes

  if (config.anchor_mode === 'progressive') {
    const lastSleep = loadLastSleepStart(db)
    if (lastSleep == null) return chaseCandidateMinutes(anchor, ideal, step)
    return signedDelta(anchor, lastSleep) <= GRACE_MINUTES
      ? chaseCandidateMinutes(anchor, ideal, step)
      : anchor
  }

  const median = loadNightMedianSleepStart(db, Date.now())
  if (median == null) return anchor
  return chaseCandidateMinutes(median, ideal, step)
}

export function computeSunsetComplianceMinutes(sleepStartUnix: number, targetBedtimeMinutes: number): number {
  const actualMinutes = getUserMinutesSinceMidnight(sleepStartUnix * 1000)
  let delta = actualMinutes - targetBedtimeMinutes

  // wrap around midnight
  if (delta > 12 * 60) delta -= 24 * 60
  if (delta < -12 * 60) delta += 24 * 60

  return delta
}

export function updateSunsetCompliance(db: Db, today: string, sleepStartUnix: number): void {
  // Requires initSunsetConfig() to have been called at server startup
  const config = getSunsetConfig()
  const compliance = computeSunsetComplianceMinutes(sleepStartUnix, config.target_bedtime_minutes)

  db.update(circadianLogs)
    .set({ sunset_compliance: compliance })
    .where(eq(circadianLogs.date, today))
    .run()
  // no-op if the circadian_logs row for today doesn't exist yet
}

function computeDissociationRisk(db: Db, today: string): number {
  const todayStart = userZonedTimeToUtc(today, 0)
  const todayEnd = todayStart + 86400

  const logs = db
    .select({ event_type: behaviorLogs.event_type, source: behaviorLogs.source })
    .from(behaviorLogs)
    .where(and(gte(behaviorLogs.logged_at, todayStart), lt(behaviorLogs.logged_at, todayEnd)))
    .all()

  let score = 0

  const screenOns = logs.filter(l => l.source === 'android' && l.event_type === 'screen_on').length
  score += Math.min(4, screenOns / 5)

  const urlVisits = logs.filter(l => l.event_type === 'url_visit').length
  score += Math.min(3, urlVisits / 10)

  const codeActive = logs.filter(l => l.event_type === 'code_active').length
  if (codeActive === 0 && logs.length > 10) score += 3
  else if (codeActive < 3) score += 1

  return Math.min(10, Math.round(score * 10) / 10)
}
