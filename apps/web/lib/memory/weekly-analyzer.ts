import type { Db } from '@anchor/db'
import type { InferenceMemory } from '@anchor/types'
import { userMemory } from '@anchor/db'

/**
 * 供 analyzeWeek 输入的行结构（来自 circadian_logs）
 * peak_work_hour：预留字段，用于未来「高峰工作时段」统计（当前 analyzeWeek 未消费）
 */
export interface WeekRow {
  date: string
  peak_distraction_hour: number | null
  peak_work_hour: number | null       // 预留：高峰工作小时，待后续消费
  intervention_dismiss_rate: number | null
  dissociation_count: number | null
  deep_work_total_ms: number | null
}

/**
 * 纯统计：7 天 circadian_logs → 扁平 InferenceMemory
 * 不含 AI weekly_insights（由计划 4 填充）
 */
export function analyzeWeek(rows: WeekRow[]): InferenceMemory {
  // highRiskHours：出现 >= 2 天的高峰分心小时视为高风险时段
  const hourCounts = new Map<number, number>()
  for (const r of rows) {
    if (r.peak_distraction_hour !== null) {
      hourCounts.set(r.peak_distraction_hour, (hourCounts.get(r.peak_distraction_hour) ?? 0) + 1)
    }
  }
  const highRiskHours = [...hourCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([h]) => h)
    .sort((a, b) => a - b)

  // highDismissal / avgDismissRate：平均 dismiss_rate > 0.7 视为高忽略
  const dismissRates = rows
    .map(r => r.intervention_dismiss_rate)
    .filter((v): v is number => v !== null)
  const avgDismissRate =
    dismissRates.length > 0
      ? dismissRates.reduce((a, b) => a + b, 0) / dismissRates.length
      : 0
  const highDismissal = avgDismissRate > 0.7

  // dissociationRising：最近 3 天解离次数单调上升
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  const last3 = sorted.slice(-3).map(r => r.dissociation_count ?? 0)
  const dissociationRising =
    last3.length === 3 && last3[0] < last3[1] && last3[1] < last3[2]

  // onboardingDays 不在此处计算：由 memory-loader 从 circadian_logs 行数推算后注入
  // （从不走 KV，避免与 4 个固定 key 的枚举冲突）
  return {
    highRiskHours,
    onboardingDays: 0,  // 占位值；memory-loader 在返回前覆盖为真实天数
    dissociationRising,
    highDismissal,
    avgDismissRate,
    typicalSleepMinutes: null, // 依赖 sleep_start 精算，留计划 4 后续
  }
}

/**
 * 把 InferenceMemory 各 key 序列化写入 user_memory（KV 表）
 * userMemory 无 user_id 列；onConflict target 为 key（UNIQUE）
 */
export function persistMemory(db: Db, mem: InferenceMemory, updatedAt: number): void {
  // 序列化为计划 4 AI 解读期待的嵌套结构，同时保留扁平字段的原始意图
  const entries: Array<[typeof userMemory.$inferInsert['key'], string]> = [
    [
      'dissociation_pattern',
      JSON.stringify({ high_risk_hours: mem.highRiskHours }),
    ],
    [
      'response_to_intervention',
      JSON.stringify({
        high_dismissal: mem.highDismissal ?? false,
        avg_dismiss_rate: mem.avgDismissRate ?? 0,
      }),
    ],
    [
      'mood_trend',
      JSON.stringify({ dissociation_rising: mem.dissociationRising ?? false }),
    ],
    [
      'sleep_pattern',
      JSON.stringify({ typical_sleep_minutes: mem.typicalSleepMinutes ?? null }),
    ],
  ]

  for (const [key, value] of entries) {
    db.insert(userMemory)
      .values({ key, value, updated_at: updatedAt })
      .onConflictDoUpdate({
        target: userMemory.key,
        set: { value, updated_at: updatedAt },
      })
      .run()
  }
}
