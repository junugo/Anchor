import type { Db } from '@anchor/db'
import { schoolSchedule } from '@anchor/db'
import { eq } from 'drizzle-orm'
import type { SchoolScheduleConfig } from '@anchor/types'
import { getDb } from '@/lib/db'
import { getUserLocalParts, userZonedTimeToUtc } from '@/lib/time/user-time'

/**
 * 学校作息配置（单行表 school_schedule）—— 上学日白天空白时段的一等语义。
 *
 * 用途：
 * - pipeline 校时段短路：inSchoolHours 且无真实用户事件 → away（在校），不推断不干预
 * - 睡眠引擎：校时段内不产生被动入睡候选（消除 phantom sleeping）；
 *   上学日 sleeping 挂到 wakeEstimateAtS 仍无活动 → school_departure 结算 sleep_end
 * - replay 回填：空档小时落在校时段 → away backfill 段（而非「无数据」）
 * - AI 上下文：注入「今天上学日」事实，避免把白天空白误读为异常
 *
 * 配置缓存挂 globalThis（同 sunset/config.ts：webpack 路由与 tsx server 双模块实例）。
 */
const globalForSchool = globalThis as unknown as {
  __anchorSchoolScheduleCache?: SchoolScheduleConfig | null
  __anchorSchoolScheduleDb?: Db | null
}

export function initSchoolSchedule(db: Db): void {
  globalForSchool.__anchorSchoolScheduleDb = db
  globalForSchool.__anchorSchoolScheduleCache = null
  const existing = db.select().from(schoolSchedule).get()
  if (!existing) {
    db.insert(schoolSchedule).values({
      enabled: true,
      days_mask: 31, // 周一~周五（bit0=周一）
      leave_minute: 420, // 07:00 出门
      home_minute: 1050, // 17:30 到家
      wake_estimate_minute: 410, // 06:50 起床估算
      term_start: null,
      term_end: null,
      exceptions: {},
      updated_at: Math.floor(Date.now() / 1000),
    }).run()
  }
}

function ensureInitialized(): void {
  if (!globalForSchool.__anchorSchoolScheduleDb) {
    initSchoolSchedule(getDb())
  }
}

export function getSchoolSchedule(): SchoolScheduleConfig {
  if (globalForSchool.__anchorSchoolScheduleCache) return globalForSchool.__anchorSchoolScheduleCache
  ensureInitialized()
  const row = globalForSchool.__anchorSchoolScheduleDb!.select().from(schoolSchedule).get()
  if (!row) throw new Error('No school schedule found')
  globalForSchool.__anchorSchoolScheduleCache = row as SchoolScheduleConfig
  return globalForSchool.__anchorSchoolScheduleCache
}

export function updateSchoolSchedule(patch: Partial<SchoolScheduleConfig>): SchoolScheduleConfig {
  ensureInitialized()
  globalForSchool.__anchorSchoolScheduleDb!.update(schoolSchedule)
    .set({ ...patch, updated_at: Math.floor(Date.now() / 1000) })
    .where(eq(schoolSchedule.id, 1))
    .run()
  globalForSchool.__anchorSchoolScheduleCache = null
  return getSchoolSchedule()
}

export interface SchoolContext {
  /** 今天是否为上学日（星期掩码 + 学期范围 + 单日例外） */
  isSchoolDay: boolean
  /** 当前是否处于在校时段（leave ~ home 之间） */
  inSchoolHours: boolean
  /** 今日出门时刻（Unix 秒） */
  leaveAtS: number
  /** 今日到家时刻（Unix 秒） */
  homeAtS: number
  /** 今日起床估算时刻（Unix 秒） */
  wakeEstimateAtS: number
}

/** weekday（0=周日 … 6=周六）→ 位索引（bit0=周一 … bit6=周日） */
function weekdayBit(weekday: number): number {
  return (weekday + 6) % 7
}

/** 某日是否为上学日（供 pipeline / 睡眠引擎 / 回填共用；dateStr 与 weekday 可由调用方算好传入） */
export function isSchoolDayFor(
  cfg: SchoolScheduleConfig,
  dateStr: string,
  weekday: number,
): boolean {
  let school = ((cfg.days_mask >> weekdayBit(weekday)) & 1) === 1
  if (cfg.term_start && dateStr < cfg.term_start) school = false
  if (cfg.term_end && dateStr > cfg.term_end) school = false
  const ex = cfg.exceptions?.[dateStr]
  if (ex === 'off') school = false
  if (ex === 'school') school = true
  return school
}

/**
 * 当前时刻的学校上下文。未启用或未播种时返回 null（等价于无日程：一切行为保持原样）。
 * 直接读库（不走全局缓存），保证测试与双模块实例下行为一致。
 */
export function getSchoolContext(db: Db, nowMs: number): SchoolContext | null {
  const row = db.select().from(schoolSchedule).get() as SchoolScheduleConfig | undefined
  if (!row || !row.enabled) return null

  const parts = getUserLocalParts(nowMs)
  const isSchoolDay = isSchoolDayFor(row, parts.dateStr, parts.weekday)
  const leaveAtS = userZonedTimeToUtc(parts.dateStr, row.leave_minute, undefined, nowMs)
  const homeAtS = userZonedTimeToUtc(parts.dateStr, row.home_minute, undefined, nowMs)
  const wakeEstimateAtS = userZonedTimeToUtc(parts.dateStr, row.wake_estimate_minute, undefined, nowMs)
  const inSchoolHours =
    isSchoolDay &&
    parts.minutesSinceMidnight >= row.leave_minute &&
    parts.minutesSinceMidnight < row.home_minute

  return { isSchoolDay, inSchoolHours, leaveAtS, homeAtS, wakeEstimateAtS }
}
