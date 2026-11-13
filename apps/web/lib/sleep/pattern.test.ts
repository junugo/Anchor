import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initSunsetConfig, updateSunsetConfig } from '../sunset/config'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'
import { buildSleepPrior, predictSleepWindow, resolveSunsetAnchor } from './pattern'
import { SLOT_COUNT } from './slots'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-pattern-${name}-`))
  const db = createDb(path.join(dir, 'anchor.db'))
  initSunsetConfig(db)
  return { dir, db }
}

/** 在某日历日期的本地 startMin–endMin（可跨午夜，endMin > 1440）插入一条 circadian_logs */
function seedSleep(db: Db, dateStr: string, startMin: number, endMin: number) {
  const dayStartS = userZonedTimeToUtc(dateStr, 0)
  db.insert(circadianLogs).values({
    date: dateStr,
    sleep_start: dayStartS + startMin * 60,
    sleep_end: dayStartS + endMin * 60,
  }).run()
}

function daysAgo(n: number): string {
  return getUserDateStr(Date.now() - n * 24 * 60 * 60 * 1000)
}

test('buildSleepPrior：跨午夜睡眠正确环绕到 slot 直方图', () => {
  const { dir, db } = tempDb('wrap')
  try {
    for (const back of [0, 1, 2]) {
      seedSleep(db, daysAgo(back), 23 * 60, 24 * 60 + 7 * 60) // 23:00–次日 07:00
    }
    const prior = buildSleepPrior(db)!
    assert.equal(prior.length, SLOT_COUNT)

    // 带内 slot：47（23:30–24:00）、0（00:00–00:30）= 1.0；46/13 是带边缘，
    // 平滑后 0.75（与无覆盖邻居各匀了 0.25）
    assert.ok(prior[47] > 0.9, `slot47=${prior[47]}`)
    assert.ok(prior[46] > 0.7 && prior[46] < 1, `slot46=${prior[46]}`)
    assert.ok(prior[0] > 0.9, `slot0=${prior[0]}`)
    assert.ok(prior[13] > 0.7 && prior[13] < 1, `slot13=${prior[13]}`)
    // 白天 slot 无覆盖（带边缘外最多 0.25）
    assert.ok(prior[20] < 0.3, `slot20=${prior[20]}`)
    // 带内高于带外
    assert.ok(prior[14] < prior[13], '带外 slot 先验应低于带内')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSleepPrior：30 天前的历史不参与；无数据返回 null', () => {
  const { dir, db } = tempDb('stale')
  try {
    assert.equal(buildSleepPrior(db), null)

    seedSleep(db, daysAgo(40), 23 * 60, 24 * 60 + 7 * 60)
    assert.equal(buildSleepPrior(db), null, '超出回看窗口的历史应被忽略')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSleepPrior：超过 16h 的脏睡眠不参与（phantom 防线）', () => {
  const { dir, db } = tempDb('dirty')
  try {
    seedSleep(db, daysAgo(0), 9 * 60, 9 * 60 + 20 * 60) // 09:00–29:00，20h
    assert.equal(buildSleepPrior(db), null)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('predictSleepWindow：有历史时预测入睡/起床带与中心', () => {
  const { dir, db } = tempDb('predict')
  try {
    for (const back of [0, 1, 2, 3, 4]) {
      seedSleep(db, daysAgo(back), 23 * 60, 24 * 60 + 7 * 60)
    }
    const w = predictSleepWindow(db)
    assert.equal(w.fromHistory, true)
    assert.equal(w.startMinutes, 23 * 60)
    assert.equal(w.endMinutes, 7 * 60)
    // 带中心应在凌晨 2–5 点之间（23:00–07:00 环绕均值）
    assert.ok(w.centerMinutes > 2 * 60 && w.centerMinutes < 5 * 60, `center=${w.centerMinutes}`)
    // stdMinutes 反映的是习惯睡眠带的宽度（约 8h 带宽 → >90min），不是入睡点抖动
    assert.ok(w.stdMinutes > 90 && w.stdMinutes < 240, `std=${w.stdMinutes}`)
    assert.ok(w.confidence > 0.5, `confidence=${w.confidence}`)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('predictSleepWindow：无历史回退静态 target_bedtime（默认 90 = 01:30）', () => {
  const { dir, db } = tempDb('fallback')
  try {
    const w = predictSleepWindow(db)
    assert.equal(w.fromHistory, false)
    assert.equal(w.startMinutes, 90)
    assert.equal(w.confidence, 0)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── resolveSunsetAnchor：倒数锚点三模式 ─────────────────────────

/** 构造稳定测试场景：连续 4 天 03:00–06:00 睡眠（带起点 180，终点 360），now 固定在本地 00:00 */
function anchorFixture(name: string) {
  const { dir, db } = tempDb(name)
  for (const back of [0, 1, 2, 3]) seedSleep(db, daysAgo(back), 3 * 60, 6 * 60)
  const nowMs = userZonedTimeToUtc(getUserDateStr(Date.now()), 0) * 1000 // 本地 00:00
  return { dir, db, nowMs }
}

test('resolveSunsetAnchor：config_hard 有历史也锚配置时间，带终点仍取学习值', () => {
  const { dir, db, nowMs } = anchorFixture('anchor-hard')
  try {
    updateSunsetConfig({ target_bedtime_minutes: 300, anchor_mode: 'config_hard' })
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 300)
    assert.equal(a.endMinutes, 360)
    assert.equal(a.mode, 'config_hard')
    assert.equal(a.fromHistory, true)
    assert.equal(a.bandStart, 180)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSunsetAnchor：adaptive_clamped 学习带早于配置时锚配置（不提前）', () => {
  const { dir, db, nowMs } = anchorFixture('anchor-clamp-early')
  try {
    updateSunsetConfig({ target_bedtime_minutes: 300, anchor_mode: 'adaptive_clamped' }) // 05:00 晚于带起点 03:00
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 300)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSunsetAnchor：adaptive_clamped 学习带晚于配置时跟随学习（可推迟）', () => {
  const { dir, db, nowMs } = anchorFixture('anchor-clamp-late')
  try {
    updateSunsetConfig({ target_bedtime_minutes: 60, anchor_mode: 'adaptive_clamped' }) // 01:00 早于带起点 03:00
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 180)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSunsetAnchor：adaptive_soft 完全跟随学习带，配置时间不参与', () => {
  const { dir, db, nowMs } = anchorFixture('anchor-soft')
  try {
    updateSunsetConfig({ target_bedtime_minutes: 300, anchor_mode: 'adaptive_soft' })
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 180)
    assert.equal(a.endMinutes, 360)
    assert.equal(a.mode, 'adaptive_soft')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSunsetAnchor：带被锚推迟到终点附近时保护带退化为锚+8h', () => {
  const { dir, db, nowMs } = anchorFixture('anchor-degenerate')
  try {
    // 配置 05:50（350），带终点 06:00（360）：span 仅 10min，退化为 350+480=830
    updateSunsetConfig({ target_bedtime_minutes: 350, anchor_mode: 'config_hard' })
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 350)
    assert.equal(a.endMinutes, 830)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSunsetAnchor：无历史时三模式都回退配置时间', () => {
  const { dir, db } = tempDb('anchor-nohistory')
  try {
    const nowMs = userZonedTimeToUtc(getUserDateStr(Date.now()), 0) * 1000
    updateSunsetConfig({ target_bedtime_minutes: 300, anchor_mode: 'adaptive_soft' })
    const a = resolveSunsetAnchor(db, nowMs)
    assert.equal(a.startMinutes, 300)
    assert.equal(a.endMinutes, 780) // 300 + 480
    assert.equal(a.fromHistory, false)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
