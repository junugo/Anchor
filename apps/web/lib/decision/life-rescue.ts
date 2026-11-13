import type { Db } from '@anchor/db'
import { circadianLogs } from '@anchor/db'
import { gte } from 'drizzle-orm'
import { getUserDateStr, getUserMinutesSinceMidnight } from '../time/user-time'

/**
 * 生活救援检查：分析最近 7 天 circadian_logs，若出现持续异常则触发 AI 提醒。
 * 每 6 小时最多执行一次。
 */
export async function checkLifeRescue(
  db: Db,
  isOnCooldown: (key: string, now: number, cooldown?: number) => boolean,
  markCooldown: (key: string, now: number) => void,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  if (isOnCooldown('life_rescue', now, 6 * 60 * 60)) return // once per 6h

  const cutoff = getUserDateStr(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const rows = db
    .select()
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoff))
    .all()

  if (rows.length < 2) return

  const recent = rows.slice(-3) // last 3 days

  const lowMealDays = recent.filter(r => r.meals_count < 2).length
  const noRoomDays = recent.filter(r => r.left_room_count === 0).length
  const TARGET_SLEEP_MINUTES = 90 // 01:30
  const highDeviationDays = recent.filter(r => {
    if (!r.sleep_start) return false
    const actualMinutes = getUserMinutesSinceMidnight(r.sleep_start * 1000)
    return Math.abs(actualMinutes - TARGET_SLEEP_MINUTES) > 4 * 60
  }).length

  const isRescue = lowMealDays >= 2 || noRoomDays >= 3 || highDeviationDays >= 2
  if (!isRescue) return

  markCooldown('life_rescue', now)

  const { triggerAiReminder } = await import('../ai/reminder')
  await triggerAiReminder(db, 'rescue')

  const { focusLayerClient } = await import('../focuslayer/client')
  if (focusLayerClient.isEnabled()) {
    await focusLayerClient.syncOut({
      circadian: { sleep_debt_hours: 0, rhythm_deviation_hours: 0, dissociation_risk: 10, last_sleep_start: null },
      environment: { current_zone: 'unknown', current_mode: 'resting' },
    })
  }
}
