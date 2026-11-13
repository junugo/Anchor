import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { circadianLogs, userLivingContext } from '@anchor/db'
import { eq, desc } from 'drizzle-orm'
import type { AnchorSyncOutPayload } from '@anchor/types'
import { getUserDateStr, getUserMinutesSinceMidnight } from '@/lib/time/user-time'

export async function GET() {
  const db = getDb()
  const today = getUserDateStr(Date.now())

  const [todayLog, ctx] = [
    db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get(),
    db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get(),
  ]

  // Compute rhythm_deviation_hours: difference between actual wake time and "ideal" 7:00
  const IDEAL_WAKEUP_MINUTES = 7 * 60 // 07:00
  let rhythmDeviation = 0
  if (todayLog?.sleep_end) {
    const actualMinutes = getUserMinutesSinceMidnight(todayLog.sleep_end * 1000)
    rhythmDeviation = Math.abs(actualMinutes - IDEAL_WAKEUP_MINUTES) / 60
  }

  // Get last sleep start (may be yesterday)
  const recentLog = db
    .select({ sleep_start: circadianLogs.sleep_start })
    .from(circadianLogs)
    .where(eq(circadianLogs.date, today))
    .orderBy(desc(circadianLogs.id))
    .get()

  const payload: AnchorSyncOutPayload = {
    circadian: {
      sleep_debt_hours: todayLog?.sleep_debt_hours ?? 0,
      rhythm_deviation_hours: rhythmDeviation,
      dissociation_risk: todayLog?.dissociation_risk_score ?? 0,
      last_sleep_start: recentLog?.sleep_start ?? null,
    },
    environment: {
      current_zone: (ctx?.location_zone ?? 'unknown') as AnchorSyncOutPayload['environment']['current_zone'],
      current_mode: (ctx?.inferred_state ?? 'resting') as AnchorSyncOutPayload['environment']['current_mode'],
    },
  }

  return NextResponse.json(payload)
}

export async function POST() {
  const { focusLayerClient } = await import('@/lib/focuslayer/client')
  if (!focusLayerClient.isEnabled()) {
    return NextResponse.json({ error: 'FocusLayer not enabled' }, { status: 400 })
  }

  const db = getDb()
  const today = getUserDateStr(Date.now())
  const [todayLog, ctx] = [
    db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get(),
    db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get(),
  ]

  const IDEAL_WAKEUP_MINUTES = 7 * 60
  let rhythmDeviation = 0
  if (todayLog?.sleep_end) {
    const actualMinutes = getUserMinutesSinceMidnight(todayLog.sleep_end * 1000)
    rhythmDeviation = Math.abs(actualMinutes - IDEAL_WAKEUP_MINUTES) / 60
  }

  await focusLayerClient.syncOut({
    circadian: {
      sleep_debt_hours: todayLog?.sleep_debt_hours ?? 0,
      rhythm_deviation_hours: rhythmDeviation,
      dissociation_risk: todayLog?.dissociation_risk_score ?? 0,
      last_sleep_start: todayLog?.sleep_start ?? null,
    },
    environment: {
      current_zone: (ctx?.location_zone ?? 'unknown') as 'desk' | 'sofa' | 'bed' | 'transition' | 'unknown',
      current_mode: (ctx?.inferred_state ?? 'resting') as 'working' | 'resting' | 'entertaining' | 'dissociating' | 'transitioning',
    },
  })

  return NextResponse.json({ ok: true })
}
