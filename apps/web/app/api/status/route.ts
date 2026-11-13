import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userLivingContext } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { computeProgressiveBedtime } from '@/lib/circadian/sleep'
import { getSunsetConfig } from '@/lib/sunset/config'
import { getSunsetPhase, getSunsetBedtimeAt, computeSunsetExpiresAt } from '@/lib/decision/sunset'
import { computeCurrentSunsetStage } from '@/lib/sleep/engine'
import { predictSleepWindow, resolveSunsetAnchor } from '@/lib/sleep/pattern'
import { getUserMinutesSinceMidnight } from '@/lib/time/user-time'

export function GET() {
  const db = getDb()
  const ctx = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
  const progressiveBedtime = computeProgressiveBedtime(db)
  const config = getSunsetConfig()
  const nowMs = Date.now()
  const nowS = Math.floor(nowMs / 1000)
  const nowMinutes = getUserMinutesSinceMidnight(nowMs)

  // 与 tick 广播、WS 握手同一真相：会话驱动的统一相位计算
  // 倒数锚点按 anchor_mode 换算（config_hard / adaptive_clamped / adaptive_soft）
  const anchor = resolveSunsetAnchor(db, nowMs, predictSleepWindow(db, nowMs))
  const bedtimeAt = getSunsetBedtimeAt(nowMs, anchor.startMinutes)
  const clockPhase = config.enabled ? getSunsetPhase(nowMinutes, anchor.startMinutes, config, anchor.endMinutes) : null
  const { stage, session } = computeCurrentSunsetStage(db, clockPhase, nowS)

  return NextResponse.json({
    inferred_state: ctx?.inferred_state ?? 'resting',
    location_zone: ctx?.location_zone ?? 'unknown',
    screen_active: ctx?.screen_active ?? false,
    updated_at: ctx?.updated_at ?? null,
    progressive_bedtime: progressiveBedtime,
    target_bedtime: anchor.startMinutes,
    anchor_mode: anchor.mode,
    sunset_phase: stage,
    expires_at: computeSunsetExpiresAt(stage, session, bedtimeAt, nowS),
  })
}
