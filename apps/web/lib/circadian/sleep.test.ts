import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { circadianLogs, closeDb, createDb } from '@anchor/db'
import { computeProgressiveBedtime, computeSunsetComplianceMinutes } from './sleep'
import { initSunsetConfig, updateSunsetConfig } from '../sunset/config'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  const db = createDb(path.join(dir, 'anchor.db'))
  initSunsetConfig(db)
  return { dir, db }
}

function unixAtLocalTime(hour: number, minute: number): number {
  // 与实现同基准（用户时区，默认 Asia/Shanghai）解释 wall time；
  // 不能用 new Date(y,m,d)：那走系统本地时区，CI（UTC）下会偏 8 小时
  return userZonedTimeToUtc('2026-06-11', hour * 60 + minute)
}

function daysAgo(n: number): string {
  return getUserDateStr(Date.now() - n * 24 * 60 * 60 * 1000)
}

test('computeSunsetComplianceMinutes returns positive minutes when sleep starts late', () => {
  assert.equal(computeSunsetComplianceMinutes(unixAtLocalTime(23, 15), 23 * 60), 15)
})

test('computeSunsetComplianceMinutes returns negative minutes when sleep starts early across midnight', () => {
  assert.equal(computeSunsetComplianceMinutes(unixAtLocalTime(0, 45), 90), -45)
})

test('computeSunsetComplianceMinutes returns positive minutes after an early-morning target', () => {
  assert.equal(computeSunsetComplianceMinutes(unixAtLocalTime(2, 0), 90), 30)
})

test('computeProgressiveBedtime 忽略白天时段的 sleep_start（phantom/午睡不拉偏目标）', () => {
  const { dir, db } = tempDb('progressive-filter')
  try {
    const insert = (date: string, minutes: number) =>
      db.insert(circadianLogs).values({
        date, sleep_start: userZonedTimeToUtc(date, minutes), meals_count: 0, left_room_count: 0,
      }).run()

    // 近 3 晚均 02:00 入睡（中位数 120）；午间 phantom 11:55 被过滤
    insert(daysAgo(1), 2 * 60)
    insert(daysAgo(2), 2 * 60)
    insert(daysAgo(3), 2 * 60)
    insert(daysAgo(4), 11 * 60 + 55)

    // 候选 = 中位数朝 ideal（默认 23:30）跟随一步 15min = 01:45
    assert.equal(computeProgressiveBedtime(db), 105)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('computeProgressiveBedtime 数据不足 3 晚时回退当前配置锚点', () => {
  const { dir, db } = tempDb('progressive-fallback')
  try {
    const today = getUserDateStr(Date.now())
    db.insert(circadianLogs).values({
      date: today, sleep_start: userZonedTimeToUtc(today, 12 * 60 + 11), meals_count: 0, left_room_count: 0,
    }).run()
    // 白天行被过滤 → <3 晚 → 回退配置 target_bedtime（默认 90 = 01:30）
    assert.equal(computeProgressiveBedtime(db), 90)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('computeProgressiveBedtime progressive 模式镜像领走语义：合规→建议再前一步，睡晚→建议即锚点', () => {
  const { dir, db } = tempDb('progressive-lead')
  try {
    updateSunsetConfig({ anchor_mode: 'progressive', target_bedtime_minutes: 120 }) // 锚点 02:00
    const insert = (date: string, minutes: number) =>
      db.insert(circadianLogs).values({
        date, sleep_start: userZonedTimeToUtc(date, minutes), meals_count: 0, left_room_count: 0,
      }).run()

    // 昨晚 02:10 入睡（gap +10 ≤ 30 合规）→ 今晚建议 = 锚点朝 ideal 再走一步 = 01:45
    insert(daysAgo(1), 2 * 60 + 10)
    assert.equal(computeProgressiveBedtime(db), 105)

    // 今晚 03:30 才入睡（gap +90 > 30）→ 今晚建议即当前锚点（原地施压）
    insert(daysAgo(0), 3 * 60 + 30)
    assert.equal(computeProgressiveBedtime(db), 120)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
