import type { Db } from '@anchor/db'
import { frictionEvents } from '@anchor/db'
import { eq, desc } from 'drizzle-orm'

export interface RecordFrictionEventInput {
  formId: string
  eventType: 'triggered' | 'bypassed'
  context?: Record<string, unknown>
  recordedAt: number // Unix seconds
}

/** 记录摩擦事件（触发或绕过） */
export function recordFrictionEvent(db: Db, input: RecordFrictionEventInput): void {
  db.insert(frictionEvents)
    .values({
      form_id: input.formId,
      event_type: input.eventType,
      context: input.context ?? {},
      recorded_at: input.recordedAt,
    })
    .run()
}

/**
 * 从最近 `limit * 2` 条记录中提取 triggered → bypassed 配对
 * 行按 recorded_at 倒序，所以 rows[i] = bypassed, rows[i+1] = triggered
 */
export function getRecentBypassPairs(
  db: Db,
  formId: string,
  limit = 10,
): Array<{ triggerAt: number; bypassAt: number }> {
  const rows = db
    .select()
    .from(frictionEvents)
    .where(eq(frictionEvents.form_id, formId))
    .orderBy(desc(frictionEvents.recorded_at))
    .limit(limit * 2)
    .all()

  const pairs: Array<{ triggerAt: number; bypassAt: number }> = []
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i]!.event_type === 'bypassed' && rows[i + 1]!.event_type === 'triggered') {
      pairs.push({ triggerAt: rows[i + 1]!.recorded_at, bypassAt: rows[i]!.recorded_at })
    }
  }
  return pairs.slice(0, limit)
}

/**
 * 计算该摩擦形式最近 5 次绕过的平均速度（毫秒）
 * 若无记录则返回 Infinity（表示从未被绕过）
 */
export function bypassSpeedMs(db: Db, formId: string): number {
  const pairs = getRecentBypassPairs(db, formId, 5)
  if (pairs.length === 0) return Infinity
  const total = pairs.reduce((sum, p) => sum + (p.bypassAt - p.triggerAt) * 1000, 0)
  return total / pairs.length
}

/**
 * 判断该摩擦形式是否已被习惯化
 * 条件（满足其一即判定为习惯化）：
 *   A. 最近 5 次绕过均在 10 秒内（绝对阈值）
 *   B. 最近 5 次绕过均比首次绕过快 70% 以上（相对阈值）
 *
 * 相对阈值用于捕获"从 100s 降至 28s（快了 72%）"但未触发绝对阈值的情况。
 * 首次绕过取历史最早一条记录（最多查 50 对）以保证稳定基准。
 */
export function isHabituated(db: Db, formId: string): boolean {
  const recentPairs = getRecentBypassPairs(db, formId, 5)
  if (recentPairs.length < 5) return false

  // 条件 A：绝对阈值，每次绕过 <10 秒
  const allFast = recentPairs.every(p => (p.bypassAt - p.triggerAt) < 10)
  if (allFast) return true

  // 条件 B：相对阈值，最近 5 次均比首次快 70%
  // 取足够多的历史数据以获得"首次"基准
  const historyPairs = getRecentBypassPairs(db, formId, 50)
  if (historyPairs.length < 6) return false // 至少要有首次 + 5 次近期记录

  // historyPairs 按时间倒序，最后一条即最早的绕过（首次）
  const firstPair = historyPairs[historyPairs.length - 1]!
  const firstDurationS = firstPair.bypassAt - firstPair.triggerAt
  if (firstDurationS <= 0) return false // 防止除零或异常数据

  // 若最近 5 次每次都比首次快 >= 70%（即不超过首次的 30%）
  const threshold = firstDurationS * 0.30
  return recentPairs.every(p => (p.bypassAt - p.triggerAt) <= threshold)
}
