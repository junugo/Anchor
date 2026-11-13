/**
 * 用户时区统一工具。
 *
 * Anchor 是个人工具，用户固定在中国内地（Asia/Shanghai）。服务器可能部署在 UTC
 * 主机（如 VPS），因此所有与用户作息相关的时钟计算都必须使用本模块，不能依赖
 * 服务器本地时区 `new Date().getHours()`。
 */

const DEFAULT_USER_TIMEZONE = 'Asia/Shanghai'

/** 用户配置时区；未配置时默认 Asia/Shanghai。 */
export function getUserTimeZone(): string {
  return process.env.ANCHOR_TZ?.trim() || DEFAULT_USER_TIMEZONE
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function getFormatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'long',
      hour12: false,
    })
    formatters.set(zone, f)
  }
  return f
}

export interface UserLocalParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
  weekday: number // 0=Sunday, 6=Saturday
  minutesSinceMidnight: number
  dateStr: string // YYYY-MM-DD
}

/**
 * 将 UTC 时间戳转换为用户时区本地分量。
 * 所有结果数字都是本地墙上时间，不受服务器时区影响。
 */
export function getUserLocalParts(nowMs: number, zone = getUserTimeZone()): UserLocalParts {
  const f = getFormatter(zone)
  const parts = f.formatToParts(new Date(nowMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = get('hour')
  const minute = get('minute')
  const second = get('second')
  const weekdayName = parts.find(p => p.type === 'weekday')?.value ?? 'Sunday'
  const weekdayMap: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  }
  const weekday = weekdayMap[weekdayName] ?? 0
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    minutesSinceMidnight: hour * 60 + minute,
    dateStr,
  }
}

export function getUserMinutesSinceMidnight(nowMs: number, zone = getUserTimeZone()): number {
  return getUserLocalParts(nowMs, zone).minutesSinceMidnight
}

export function getUserHour(nowMs: number, zone = getUserTimeZone()): number {
  return getUserLocalParts(nowMs, zone).hour
}

export function getUserWeekday(nowMs: number, zone = getUserTimeZone()): number {
  return getUserLocalParts(nowMs, zone).weekday
}

export function getUserDateStr(nowMs: number, zone = getUserTimeZone()): string {
  return getUserLocalParts(nowMs, zone).dateStr
}

/**
 * 睡眠日期：以中午 12:00 为界。
 * 0:00–11:59 属于前一个睡眠日期；12:00–23:59 属于当前日历日期。
 */
export function getUserSleepDateStr(nowMs: number, zone = getUserTimeZone()): string {
  const { hour, dateStr } = getUserLocalParts(nowMs, zone)
  if (hour < 12) {
    return getUserDateStr(nowMs - 24 * 60 * 60 * 1000, zone)
  }
  return dateStr
}

/** 用户时区相对于 UTC 的偏移毫秒（正数 = 东）。 */
export function getUserOffsetMs(utcMs: number, zone = getUserTimeZone()): number {
  const f = getFormatter(zone)
  const parts = f.formatToParts(new Date(utcMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return utcMs - localMs
}

/**
 * 将用户本地日期 + 分钟数（0 = 00:00）转换为 Unix 秒。
 * 用于计算下一次就寝时间等固定本地时刻。
 *
 * 实现：先按当前偏移估算，再迭代两次收敛（处理 DST 边界）。
 */
export function userZonedTimeToUtc(
  dateStr: string,
  minutesSinceMidnight: number,
  zone = getUserTimeZone(),
  nowMs = Date.now(),
): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const baseMs = Date.UTC(y, m - 1, d, 0, 0, 0)
  const targetLocalMs = baseMs + minutesSinceMidnight * 60 * 1000

  // 用当前偏移作初值，避免在 DST 区域迭代次数过多
  let offsetMs = getUserOffsetMs(nowMs, zone)
  let utcMs = targetLocalMs + offsetMs
  // 两次迭代对 DST 边界足够收敛
  for (let i = 0; i < 2; i++) {
    offsetMs = getUserOffsetMs(utcMs, zone)
    utcMs = targetLocalMs + offsetMs
  }

  return Math.floor(utcMs / 1000)
}

/** 下一次本地时间就寝时刻的 Unix 秒；如果已过则取次日。 */
export function getUserSunsetBedtimeAt(
  nowMs: number,
  targetBedtimeMinutes: number,
  zone = getUserTimeZone(),
): number {
  const parts = getUserLocalParts(nowMs, zone)
  const todayBedtimeS = userZonedTimeToUtc(parts.dateStr, targetBedtimeMinutes, zone, nowMs)
  if (todayBedtimeS * 1000 <= nowMs) {
    const tomorrowMs = nowMs + 24 * 60 * 60 * 1000
    const tomorrowStr = getUserDateStr(tomorrowMs, zone)
    return userZonedTimeToUtc(tomorrowStr, targetBedtimeMinutes, zone, nowMs)
  }
  return todayBedtimeS
}

/**
 * 本地分钟数是否落在 [start, end) 带内（两端自动按 24h 取模，支持跨午夜带）。
 * 睡眠带语义：start ≤ now < end，end 排他（与 slot 区间 [start, end) 一致）。
 */
export function isWithinLocalMinutesBand(minutes: number, start: number, end: number): boolean {
  const M = 24 * 60
  const m = ((minutes % M) + M) % M
  const s = ((start % M) + M) % M
  const e = ((end % M) + M) % M
  if (s <= e) return m >= s && m < e
  return m >= s || m < e // 跨午夜带
}
