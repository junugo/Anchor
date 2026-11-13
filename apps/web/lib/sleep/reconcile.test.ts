import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, behaviorLogs, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { initSunsetConfig } from '../sunset/config'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'
import { reconcileSleepDay } from './reconcile'
import { SLOT_MINUTES } from './slots'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-reconcile-${name}-`))
  const db = createDb(path.join(dir, 'anchor.db'))
  initSunsetConfig(db)
  return { dir, db }
}

function seedLog(db: Db, source: string, eventType: string, loggedAt: number, payload: Record<string, unknown> = {}) {
  db.insert(behaviorLogs).values({ source, event_type: eventType, payload, logged_at: loggedAt }).run()
}

function seedCircadianSleep(db: Db, date: string, startMin: number, endMin: number) {
  const dayStartS = userZonedTimeToUtc(date, 0)
  db.insert(circadianLogs).values({
    date,
    sleep_start: dayStartS + startMin * 60,
    sleep_end: dayStartS + endMin * 60,
  }).run()
}

/** 睡眠日窗口起点（本地 12:00）的 Unix 秒 */
function winStart(sleepDate: string): number {
  return userZonedTimeToUtc(sleepDate, 12 * 60)
}

/** 本地分钟数（可 >1440 表次日）→ 窗口相对分钟 */
function relMin(localMin: number): number {
  return (localMin - 12 * 60 + 24 * 60) % (24 * 60)
}

/** 往睡眠日窗口内种一段「真实睡眠」信号：灭屏 + 静止 + 无交互（时间用本地分钟） */
function seedNightSleepSignals(db: Db, windowStartS: number, startLocalMin: number, endLocalMin: number) {
  const start = relMin(startLocalMin)
  const end = relMin(endLocalMin)
  seedLog(db, 'android', 'screen_off', windowStartS + start * 60)
  seedLog(db, 'android', 'screen_on', windowStartS + end * 60)
  seedLog(db, 'android', 'screen_unlock', windowStartS + end * 60)
  for (let m = start; m < end; m += 5) {
    seedLog(db, 'android', 'physical_activity', windowStartS + m * 60, { activity_type: 'still' })
  }
}

const NOW = Date.now()
const TODAY = getUserDateStr(NOW)

function daysAgoStr(n: number): string {
  return getUserDateStr(NOW - n * 24 * 60 * 60 * 1000)
}

test('漏记回填：识别出主睡眠段但无记录 → apply 写库并可幂等重入', () => {
  const { dir, db } = tempDb('backfill')
  try {
    const sleepDate = daysAgoStr(2)
    // 先验来源：另外两个睡眠日的确认记录（23:00–07:00）
    seedCircadianSleep(db, daysAgoStr(4), 23 * 60, 24 * 60 + 7 * 60)
    seedCircadianSleep(db, daysAgoStr(3), 23 * 60, 24 * 60 + 7 * 60)

    // 目标日：真实睡眠 23:30–07:00，但没有任何记录
    const win = winStart(sleepDate)
    seedNightSleepSignals(db, win, 23 * 60 + 30, 24 * 60 + 7 * 60)

    const dry = reconcileSleepDay(db, sleepDate, NOW, false)
    assert.equal(dry.changed, true)
    assert.ok(dry.logs[0].includes('漏记'), dry.logs[0])
    assert.equal(db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get(), undefined, 'dry-run 不写库')

    const applied = reconcileSleepDay(db, sleepDate, NOW, true)
    assert.equal(applied.changed, true)
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()!
    assert.ok(Math.abs(row.sleep_start! - (win + relMin(23 * 60 + 30) * 60)) <= SLOT_MINUTES * 60, `sleep_start 偏差过大: ${row.sleep_start}`)
    assert.ok(row.sleep_end! <= win + 24 * 60 * 60 && row.sleep_end! > row.sleep_start!)
    assert.ok(row.sleep_reconciled_at != null)
    assert.ok(row.sleep_debt_hours != null, '回填后应重算睡眠债')

    // 幂等：再跑一遍只产生跳过报告
    const again = reconcileSleepDay(db, sleepDate, NOW, true)
    assert.equal(again.changed, false)
    assert.ok(again.logs[0].includes('已处理过'))
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('phantom 清理：有记录但全天活跃、识别无睡眠段 → 作废记录', () => {
  const { dir, db } = tempDb('phantom')
  try {
    const sleepDate = daysAgoStr(2)
    // phantom 记录：白天 12:30–15:00「睡」了
    seedCircadianSleep(db, sleepDate, 12 * 60 + 30, 15 * 60)
    // 但当天全天真实活跃：桌面 5s 节奏 + 手机交互 + 亮屏
    const win = userZonedTimeToUtc(sleepDate, 12 * 60)
    seedLog(db, 'android', 'screen_on', win + 13 * 60 * 60)
    for (let s = 0; s < 24 * 60 * 60; s += 5) {
      seedLog(db, 'desktop', 'window_focus', win + s, { duration_ms: 5000 })
    }
    for (let m = 0; m < 24 * 60; m += 30) {
      seedLog(db, 'android', 'screen_unlock', win + m * 60)
    }

    const result = reconcileSleepDay(db, sleepDate, NOW, true)
    assert.equal(result.changed, true)
    assert.ok(result.logs[0].includes('phantom'), result.logs[0])
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()!
    assert.equal(row.sleep_start, null)
    assert.equal(row.sleep_end, null)
    assert.ok(row.sleep_reconciled_at != null)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('一致：记录与识别重叠 → 不改动，打幂等标记', () => {
  const { dir, db } = tempDb('consistent')
  try {
    const sleepDate = daysAgoStr(2)
    seedCircadianSleep(db, daysAgoStr(4), 23 * 60, 24 * 60 + 7 * 60)
    seedCircadianSleep(db, daysAgoStr(3), 23 * 60, 24 * 60 + 7 * 60)
    // 记录 23:40–06:50
    const win = userZonedTimeToUtc(sleepDate, 12 * 60)
    seedCircadianSleep(db, sleepDate, 23 * 60 + 40, 24 * 60 + 6 * 60 + 50)
    // 信号 23:30–07:00：重叠 > 50%
    seedNightSleepSignals(db, win, 23 * 60 + 30, 24 * 60 + 7 * 60)

    const result = reconcileSleepDay(db, sleepDate, NOW, true)
    assert.equal(result.changed, false)
    assert.ok(result.logs[0].includes('一致'), result.logs[0])
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()!
    assert.notEqual(row.sleep_start, null, '一致时保留原记录')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('窗口未结束：当天不处理', () => {
  const { dir, db } = tempDb('future')
  try {
    // 用「今天」作为睡眠日：其窗口 12:00 起 24h，此刻大概率未结束（或刚结束）
    const result = reconcileSleepDay(db, TODAY, NOW, true)
    assert.equal(result.changed, false)
    assert.ok(result.logs[0].includes('未结束'))
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
