import { getDb } from '../db'
import { circadianLogs, userSettings } from '@anchor/db'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from '@anchor/db'
import { triggerAiReminder } from '../ai/reminder'
import { updateSleepMetrics, updateSunsetCompliance } from './sleep'
import { getUserDateStr, getUserLocalParts, getUserSleepDateStr } from '../time/user-time'

/**
 * 找「已记录 sleep_start 且 sleep_end 为空」的开放行（最近一条）。
 * 跨午夜睡眠的 start 按 12:00 分界归前一睡眠日，end 必须写回同一行，
 * 否则 03:00 睡 06:00 起会被拆到两行，睡眠债务永远算不出。
 */
function findOpenSleepRow(db: Db): { date: string; sleep_start: number | null } | undefined {
  return db
    .select({ date: circadianLogs.date, sleep_start: circadianLogs.sleep_start })
    .from(circadianLogs)
    .where(and(isNotNull(circadianLogs.sleep_start), isNull(circadianLogs.sleep_end)))
    .orderBy(desc(circadianLogs.date))
    .limit(1)
    .get()
}

/** 行内 start/end 先后校验：拒绝会产生 start > end 的写入，返回 false */
function wouldBreakStartEnd(start: number | null, end: number | null): boolean {
  return start != null && end != null && start >= end
}

export function recordWakeup() {
  const db = getDb()
  const nowMs = Date.now()
  const now = Math.floor(nowMs / 1000)
  const open = findOpenSleepRow(db)
  const today = open?.date ?? getUserDateStr(nowMs)

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  if (existing && wouldBreakStartEnd(existing.sleep_start, now)) {
    // 行内已有更晚的 sleep_start（如次日清晨的迟来探测值），拒绝写 end 避免负时长脏行
    console.warn(`[circadian] 拒绝写入 sleep_end=${now}：${today} 行已有 sleep_start=${existing.sleep_start}（更晚），先修正 start`)
  } else if (existing) {
    db.update(circadianLogs).set({ sleep_end: now }).where(eq(circadianLogs.date, today)).run()
  } else {
    db.insert(circadianLogs).values({ date: today, sleep_end: now, meals_count: 0, left_room_count: 0 }).run()
  }

  updateSleepMetrics(db, today)
  const firstActionRow = db.select().from(userSettings).where(eq(userSettings.key, 'first_action')).get()
  triggerAiReminder(db, 'wakeup', { firstAction: firstActionRow?.value ?? null }).catch(console.error)

  // 起床验证通过：立即解除当日 T0 宵禁，不等就寝后 8 小时窗口自然结束
  import('../decision/sunset')
    .then(m => m.clearSunsetByWakeup())
    .catch(console.error)

  // 意图锚点层：起床后展示昨晚记录的意图，供用户确认或修改
  import('../intention/anchor')
    .then(m => m.triggerIntentConfirmOnWakeup(db))
    .catch(console.error)

  // 意图锚点层：将今日意图绑定到上午首个时间块——以 time:anchor 广播注入
  // 若今日已有意图则以其文本替代通用标签；无意图则广播普通早安时间锚
  bindMorningIntention(db, nowMs).catch(console.error)
}

/**
 * 上午首个时间块绑定到今日意图。
 *
 * 实现策略：通过 time:anchor 广播将意图文本注入到所有客户端的晨间时间块标签，
 * 替代通用的"早上"标签。若无当日意图则退回到标准时间锚格式。
 */
async function bindMorningIntention(db: Db, nowMs: number): Promise<void> {
  const { getTodayIntention } = await import('../intention/anchor')
  const intention = getTodayIntention(db)

  const { broadcast } = await import('../ws/server')
  const { hour, minute } = getUserLocalParts(nowMs)
  const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  if (intention) {
    // 以今日意图文本作为上午首个时间块标签
    broadcast({
      type: 'time:anchor',
      text: `早上 ${timeLabel} · 今日意图：${intention.content}`,
    })
  } else {
    // 无意图时退回到标准早安时间锚
    broadcast({
      type: 'time:anchor',
      text: `早上 ${timeLabel} · 新的一天开始了`,
    })
  }
}

export function recordSleepStart() {
  const db = getDb()
  const nowMs = Date.now()
  const today = getUserSleepDateStr(nowMs)
  const now = Math.floor(nowMs / 1000)

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  // 防御：真实入睡点取最早探测——迟来的值（如次日清晨延迟 auto-confirm）不得覆盖；
  // 行内已有 end 时 start 不得晚于它（属于已闭合的旧睡眠，不应回写）
  if (existing && wouldBreakStartEnd(now, existing.sleep_end)) {
    console.warn(`[circadian] 拒绝写入 sleep_start=${now}：${today} 行已有 sleep_end=${existing.sleep_end}（start 不得晚于 end）`)
  } else if (existing && existing.sleep_start != null && now >= existing.sleep_start) {
    // 已有更早的入睡记录，保留较早值
  } else if (existing) {
    db.update(circadianLogs).set({ sleep_start: now }).where(eq(circadianLogs.date, today)).run()
    updateSunsetCompliance(db, today, now)
  } else {
    db.insert(circadianLogs).values({ date: today, sleep_start: now, meals_count: 0, left_room_count: 0 }).run()
    updateSunsetCompliance(db, today, now)
  }

  // 手动点「睡了」：驱动睡眠状态机进入 sleeping（sleep_start = 点击时间）
  import('../sleep/engine')
    .then(m => m.reportSleepStart(db))
    .catch(console.error)
}

/**
 * 写入精确的 sleep_start 到 circadian_logs（用于被动检测 auto-confirm 路径）。
 * 与 recordSleepStart 的区别：接受外部传入的时间戳，不驱动状态机（状态机已在 auto-confirm 中处理）。
 */
export function recordSleepStartAt(db: Db, sleepStartS: number): void {
  const today = getUserSleepDateStr(sleepStartS * 1000)

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  // 同 recordSleepStart：迟来的探测值（auto-confirm 回算可能晚于手动点击）不得覆盖更早记录
  if (existing && wouldBreakStartEnd(sleepStartS, existing.sleep_end)) {
    console.warn(`[circadian] 拒绝写入 sleep_start=${sleepStartS}：${today} 行已有 sleep_end=${existing.sleep_end}`)
    return
  }
  if (existing && existing.sleep_start != null && sleepStartS >= existing.sleep_start) return

  if (existing) {
    db.update(circadianLogs).set({ sleep_start: sleepStartS }).where(eq(circadianLogs.date, today)).run()
  } else {
    db.insert(circadianLogs).values({ date: today, sleep_start: sleepStartS, meals_count: 0, left_room_count: 0 }).run()
  }

  updateSunsetCompliance(db, today, sleepStartS)
}

/**
 * 写入精确的 sleep_end 到 circadian_logs（上学日晨间结算路径）。
 * 归属日取 sleep_start 的睡眠日（中午分界），与 recordSleepStartAt 的写入行配对——
 * 否则会把 sleep_end 写到「今天」行而 sleep_start 在「昨天」行，睡眠债务永远算不出来。
 */
export function recordSleepEndAt(db: Db, sleepStartS: number, wakeAtS: number): void {
  const today = getUserSleepDateStr(sleepStartS * 1000)

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  if (existing && wouldBreakStartEnd(existing.sleep_start, wakeAtS)) {
    console.warn(`[circadian] 拒绝写入 sleep_end=${wakeAtS}：${today} 行已有 sleep_start=${existing.sleep_start}（更晚）`)
    return
  }
  if (existing) {
    db.update(circadianLogs).set({ sleep_end: wakeAtS }).where(eq(circadianLogs.date, today)).run()
  } else {
    db.insert(circadianLogs).values({ date: today, sleep_end: wakeAtS, meals_count: 0, left_room_count: 0 }).run()
  }

  updateSleepMetrics(db, today)
}

/**
 * 写入 sleep_end = now（REST sleep_end / 一般结算路径）。
 * 归属：优先「有 sleep_start 且 sleep_end 为空」的开放行（跨午夜睡眠），
 * 找不到开放行才回退日历日。返回实际写入的 date，调用方据此刷新派生指标。
 */
export function recordSleepEnd(db: Db, endS: number): string {
  const open = findOpenSleepRow(db)
  const today = open?.date ?? getUserDateStr(endS * 1000)

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()
  if (existing && wouldBreakStartEnd(existing.sleep_start, endS)) {
    console.warn(`[circadian] 拒绝写入 sleep_end=${endS}：${today} 行已有 sleep_start=${existing.sleep_start}（更晚）`)
    return today
  }
  if (existing) {
    db.update(circadianLogs).set({ sleep_end: endS }).where(eq(circadianLogs.date, today)).run()
  } else {
    db.insert(circadianLogs).values({ date: today, sleep_end: endS, meals_count: 0, left_room_count: 0 }).run()
  }

  updateSleepMetrics(db, today)
  updateSunsetCompliance(db, today, endS)
  return today
}

/**
 * 作废一次入睡登记：将 circadian_logs 中对应归属日的 sleep_start 与派生指标 sunset_compliance 置 NULL。
 * 场景 B「还没睡」假警报路径调用，与 recordSleepStart/recordSleepStartAt 的写入配对。
 */
export function clearRecordedSleepStart(db: Db, sleepStartS: number): void {
  const today = getUserSleepDateStr(sleepStartS * 1000)

  db.update(circadianLogs).set({ sleep_start: null, sunset_compliance: null }).where(eq(circadianLogs.date, today)).run()
}
