import type { Db } from '@anchor/db'
import { decisionCooldowns } from '@anchor/db'
import { eq } from 'drizzle-orm'

const DECISION_COOLDOWN_S = 5 * 60 // 5 分钟内同类型决策只触发一次

/**
 * 检查指定 key 是否处于冷却期。
 * 从 SQLite decision_cooldowns 表读取，替代内存 lastDecisionAt。
 */
export function isOnCooldown(db: Db, key: string, now: number, cooldown = DECISION_COOLDOWN_S): boolean {
  const row = db
    .select({ last_triggered_at: decisionCooldowns.last_triggered_at })
    .from(decisionCooldowns)
    .where(eq(decisionCooldowns.key, key))
    .get()
  const last = row?.last_triggered_at ?? 0
  return last + cooldown > now
}

/**
 * 标记指定 key 已触发，写入/更新 SQLite decision_cooldowns 表。
 */
export function markCooldown(db: Db, key: string, now: number): void {
  db.insert(decisionCooldowns)
    .values({ key, last_triggered_at: now, updated_at: now })
    .onConflictDoUpdate({
      target: decisionCooldowns.key,
      set: { last_triggered_at: now, updated_at: now },
    })
    .run()
}

/**
 * 重置所有冷却记录（测试专用）。
 */
export function resetCooldowns(db: Db): void {
  db.delete(decisionCooldowns).run()
}
