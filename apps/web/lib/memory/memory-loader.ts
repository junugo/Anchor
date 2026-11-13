import type { Db } from '@anchor/db'
import type { InferenceMemory } from '@anchor/types'
import { circadianLogs, userMemory } from '@anchor/db'
import { count } from 'drizzle-orm'

export type ColdStartPhase = 'recording' | 'transition' | 'full'

/**
 * 按已运行天数（onboardingDays）判断冷启动阶段：
 * - recording（0-2天）：纯记录，不注入记忆
 * - transition（3-13天）：减半注入，辅助推断
 * - full（14天起）：完整注入
 */
export function coldStartPhase(onboardingDays: number): ColdStartPhase {
  if (onboardingDays < 3) return 'recording'
  if (onboardingDays < 14) return 'transition'
  return 'full'
}

/** 注入强度系数：recording = 0、transition = 0.5、full = 1 */
export function injectionScale(onboardingDays: number): number {
  switch (coldStartPhase(onboardingDays)) {
    case 'recording': return 0
    case 'transition': return 0.5
    case 'full': return 1
  }
}

/**
 * 从 circadian_logs 行数推算已运行天数。
 * 每日归档写入一行，行数即近似的使用天数。
 * 使用 COUNT(*) 聚合，避免拉取全量列。
 */
export function getOnboardingDays(db: Db): number {
  const result = db.select({ n: count() }).from(circadianLogs).get()
  return result?.n ?? 0
}

/**
 * 从 user_memory KV 表读取 InferenceMemory（扁平结构）。
 * 冷启动 recording 阶段返回 undefined（不参与推断）。
 * onboardingDays 由 circadian_logs 行数动态推算后注入。
 */
export function loadMemory(db: Db): InferenceMemory | undefined {
  const onboardingDays = getOnboardingDays(db)
  if (injectionScale(onboardingDays) === 0) return undefined

  const rows = db.select({ key: userMemory.key, value: userMemory.value }).from(userMemory).all()
  // 显式标注 Map 类型，消除 key 枚举窄化导致的类型强转
  const kv = new Map<string, string>(rows.map(r => [r.key, r.value]))

  const parse = <T>(key: string, fallback: T): T => {
    const raw = kv.get(key)
    if (!raw) return fallback
    try { return JSON.parse(raw) as T } catch { return fallback }
  }

  // 从序列化的嵌套结构还原扁平 InferenceMemory 字段
  const dissociation = parse<{ high_risk_hours?: number[] }>('dissociation_pattern', {})
  const intervention = parse<{ high_dismissal?: boolean; avg_dismiss_rate?: number }>('response_to_intervention', {})
  const mood = parse<{ dissociation_rising?: boolean }>('mood_trend', {})
  const sleep = parse<{ typical_sleep_minutes?: number | null }>('sleep_pattern', {})

  return {
    highRiskHours: dissociation.high_risk_hours ?? [],
    onboardingDays,
    dissociationRising: mood.dissociation_rising ?? false,
    highDismissal: intervention.high_dismissal ?? false,
    avgDismissRate: intervention.avg_dismiss_rate ?? 0,
    typicalSleepMinutes: sleep.typical_sleep_minutes ?? null,
  }
}
