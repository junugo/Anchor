/**
 * Module 6：摩擦转移系统 — 替代物库管理
 *
 * 职责：
 * 1. 根据时间段和当前严重度查询优先替代物（减摩擦路径）
 * 2. 记录替代物使用日志
 * 3. 根据使用日志更新替代物有效性分数（AI 动态维护）
 */

import type { Db } from '@anchor/db'
import { alternativeLibrary, alternativeUsageLogs } from '@anchor/db'
import { eq, desc } from 'drizzle-orm'

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'deep_night'

/** 根据当前小时返回时间段标签 */
export function getTimeOfDay(hourOfDay: number): TimeOfDay {
  if (hourOfDay >= 5 && hourOfDay < 12) return 'morning'
  if (hourOfDay >= 12 && hourOfDay < 18) return 'afternoon'
  if (hourOfDay >= 18 && hourOfDay < 23) return 'evening'
  return 'deep_night'
}

export interface AlternativeEntry {
  id: number
  name: string
  category: string
  launch_url: string | null
  priority_score: number
  effective_count: number
  ineffective_count: number
}

/**
 * 查询当前最优替代物（减摩擦：减少选择成本）
 *
 * 优先返回：
 * 1. 与当前时间段匹配的替代物（或全时段适用）
 * 2. 按 priority_score 降序排列
 * 3. 最多返回 topN 条，供 UI 一键直达展示
 */
export function getTopAlternatives(
  db: Db,
  timeOfDay: TimeOfDay,
  topN = 4,
): AlternativeEntry[] {
  const allActive = db
    .select()
    .from(alternativeLibrary)
    .where(eq(alternativeLibrary.active, true))
    .orderBy(desc(alternativeLibrary.priority_score))
    .all()

  // 优先时间段匹配的；全时段（空 slots 数组）的总是合格
  const matched = allActive.filter(row => {
    const slots = row.preferred_time_slots as string[]
    return slots.length === 0 || slots.includes(timeOfDay)
  })

  // 若匹配数量不足，补充剩余的（按 priority_score）
  const others = allActive.filter(row => !matched.includes(row))
  const candidates = [...matched, ...others]

  return candidates.slice(0, topN).map(row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    launch_url: row.launch_url ?? null,
    priority_score: row.priority_score,
    effective_count: row.effective_count,
    ineffective_count: row.ineffective_count,
  }))
}

export interface RecordUsageInput {
  alternativeId: number
  triggerState: string
  severityLevel: string | null
  timeOfDay: TimeOfDay
  startedAt: number  // Unix 秒
}

/** 记录替代物开始使用 — 返回 usage log id（用于后续上报使用时长） */
export function recordAlternativeStart(db: Db, input: RecordUsageInput): number {
  const result = db
    .insert(alternativeUsageLogs)
    .values({
      alternative_id: input.alternativeId,
      trigger_state: input.triggerState,
      severity_level: input.severityLevel,
      time_of_day: input.timeOfDay,
      duration_seconds: null,
      outcome: 'unknown',
      started_at: input.startedAt,
    })
    .run()
  return Number(result.lastInsertRowid)
}

export interface RecordUsageEndInput {
  usageLogId: number
  durationSeconds: number
}

/**
 * 上报替代物使用时长，并更新替代物库有效性统计
 *
 * 有效性规则（Module 6 规格）：
 * - 持续 >10 分钟（600 秒）→ effective，priority_score += 5（上限 100）
 * - <2 分钟（120 秒）退出  → ineffective，priority_score -= 3（下限 10）
 * - 其余                  → unknown，不调整分数
 */
export function recordAlternativeEnd(db: Db, input: RecordUsageEndInput): void {
  const { usageLogId, durationSeconds } = input

  const logRow = db
    .select()
    .from(alternativeUsageLogs)
    .where(eq(alternativeUsageLogs.id, usageLogId))
    .get()

  if (!logRow) return

  let outcome: 'effective' | 'ineffective' | 'unknown' = 'unknown'
  if (durationSeconds > 600) outcome = 'effective'
  else if (durationSeconds < 120) outcome = 'ineffective'

  // 更新使用日志
  db.update(alternativeUsageLogs)
    .set({ duration_seconds: durationSeconds, outcome })
    .where(eq(alternativeUsageLogs.id, usageLogId))
    .run()

  if (outcome === 'unknown') return

  // 更新替代物库统计与优先级分
  const altRow = db
    .select()
    .from(alternativeLibrary)
    .where(eq(alternativeLibrary.id, logRow.alternative_id))
    .get()

  if (!altRow) return

  const nowS = Math.floor(Date.now() / 1000)

  if (outcome === 'effective') {
    const newScore = Math.min(100, altRow.priority_score + 5)
    db.update(alternativeLibrary)
      .set({
        effective_count: altRow.effective_count + 1,
        priority_score: newScore,
        updated_at: nowS,
      })
      .where(eq(alternativeLibrary.id, altRow.id))
      .run()
  } else {
    const newScore = Math.max(10, altRow.priority_score - 3)
    db.update(alternativeLibrary)
      .set({
        ineffective_count: altRow.ineffective_count + 1,
        priority_score: newScore,
        updated_at: nowS,
      })
      .where(eq(alternativeLibrary.id, altRow.id))
      .run()
  }
}

// ── 内置默认替代物（冷启动种子数据）────────────────────────────────────────

const DEFAULT_ALTERNATIVES: Array<{
  name: string
  category: 'audio' | 'reading' | 'movement' | 'breathing' | 'other'
  launch_url: string | null
  preferred_time_slots: TimeOfDay[]
  priority_score: number
}> = [
  { name: '白噪音', category: 'audio', launch_url: null, preferred_time_slots: ['evening', 'deep_night'], priority_score: 70 },
  { name: '冥想音频', category: 'audio', launch_url: null, preferred_time_slots: ['evening', 'deep_night'], priority_score: 65 },
  { name: '深呼吸练习', category: 'breathing', launch_url: null, preferred_time_slots: [], priority_score: 60 },
  { name: '阅读（长文 / 书籍）', category: 'reading', launch_url: null, preferred_time_slots: ['morning', 'afternoon', 'evening'], priority_score: 55 },
  { name: '伸展运动', category: 'movement', launch_url: null, preferred_time_slots: [], priority_score: 50 },
]

/**
 * 初始化默认替代物（仅在表为空时插入，确保冷启动可用性）
 */
export function seedDefaultAlternatives(db: Db): void {
  const count = db.select().from(alternativeLibrary).all().length
  if (count > 0) return

  const nowS = Math.floor(Date.now() / 1000)
  for (const alt of DEFAULT_ALTERNATIVES) {
    try {
      db.insert(alternativeLibrary).values({
        name: alt.name,
        category: alt.category,
        launch_url: alt.launch_url,
        preferred_time_slots: alt.preferred_time_slots,
        priority_score: alt.priority_score,
        effective_count: 0,
        ineffective_count: 0,
        active: true,
        created_at: nowS,
        updated_at: nowS,
      }).run()
    } catch { /* ignore duplicate on re-init */ }
  }
}
