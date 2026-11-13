import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  getUserLocalParts,
  getUserMinutesSinceMidnight,
  getUserDateStr,
  getUserSleepDateStr,
  getUserSunsetBedtimeAt,
  userZonedTimeToUtc,
} from './user-time'

process.env.ANCHOR_TZ = 'Asia/Shanghai'

// 2026-08-26 17:28:16 CST = 09:28:16 UTC
const SAMPLE_CST_MS = Date.UTC(2026, 7, 26, 9, 28, 16)

describe('getUserLocalParts', () => {
  it(' Asia/Shanghai 下把 UTC 时间正确转成本地时间', () => {
    const p = getUserLocalParts(SAMPLE_CST_MS)
    assert.equal(p.year, 2026)
    assert.equal(p.month, 8)
    assert.equal(p.day, 26)
    assert.equal(p.hour, 17)
    assert.equal(p.minute, 28)
    assert.equal(p.second, 16)
    assert.equal(p.weekday, 3) // Wednesday
    assert.equal(p.minutesSinceMidnight, 17 * 60 + 28)
    assert.equal(p.dateStr, '2026-08-26')
  })
})

describe('getUserMinutesSinceMidnight / getUserDateStr', () => {
  it('返回正确的小分钟数和日期', () => {
    assert.equal(getUserMinutesSinceMidnight(SAMPLE_CST_MS), 1048)
    assert.equal(getUserDateStr(SAMPLE_CST_MS), '2026-08-26')
  })
})

describe('getUserSleepDateStr', () => {
  it('12:00 前属于前一天睡眠日期', () => {
    // 2026-08-26 11:59 CST
    const ms = Date.UTC(2026, 7, 26, 3, 59, 0)
    assert.equal(getUserSleepDateStr(ms), '2026-08-25')
  })

  it('12:00 后属于当天睡眠日期', () => {
    // 2026-08-26 12:01 CST
    const ms = Date.UTC(2026, 7, 26, 4, 1, 0)
    assert.equal(getUserSleepDateStr(ms), '2026-08-26')
  })
})

describe('userZonedTimeToUtc', () => {
  it('本地 2026-08-26 03:30 转回 UTC 是前一天 19:30', () => {
    const s = userZonedTimeToUtc('2026-08-26', 210)
    const d = new Date(s * 1000)
    assert.equal(d.toISOString(), '2026-08-25T19:30:00.000Z')
  })

  it('本地 2026-08-26 12:00 转回 UTC 是 04:00', () => {
    const s = userZonedTimeToUtc('2026-08-26', 12 * 60)
    const d = new Date(s * 1000)
    assert.equal(d.toISOString(), '2026-08-26T04:00:00.000Z')
  })
})

describe('getUserSunsetBedtimeAt', () => {
  it('就寝时间未到则返回当天就寝时刻', () => {
    // 2026-08-26 02:00 CST，target=210(03:30)
    const now = Date.UTC(2026, 7, 25, 18, 0, 0)
    const s = getUserSunsetBedtimeAt(now, 210)
    assert.equal(new Date(s * 1000).toISOString(), '2026-08-25T19:30:00.000Z')
  })

  it('就寝时间已过则返回次日就寝时刻', () => {
    // 2026-08-26 05:00 CST，target=210(03:30)
    const now = Date.UTC(2026, 7, 25, 21, 0, 0)
    const s = getUserSunsetBedtimeAt(now, 210)
    assert.equal(new Date(s * 1000).toISOString(), '2026-08-26T19:30:00.000Z')
  })
})
