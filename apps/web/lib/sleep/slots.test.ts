import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, behaviorLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SLOT_COUNT,
  SLOT_MINUTES,
  computeDayFeatures,
  scoreSlots,
  smoothScores,
  assembleSleepSegments,
  mainSegment,
  DEFAULT_SCORE_WEIGHTS,
} from './slots'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-slots-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

// 睡眠日窗口：本地 12:00 起 24h（与 sessionDateKey 一致，跨午夜灭屏配对不出窗）。
// slots.ts 本身不做时区换算，纯 Unix 区间运算，测试用本地墙钟即可。
const BASE = new Date()
BASE.setHours(12, 0, 0, 0)
const WIN0 = Math.floor(BASE.getTime() / 1000) // 本地 12:00 的 Unix 秒

/** 本地分钟数（0–1439；可传 >1440 表示次日）→ 窗口内 Unix 秒 */
function at(localMin: number): number {
  return WIN0 + ((localMin - 12 * 60 + 24 * 60) % (24 * 60)) * 60
}

/** 本地分钟数 → 窗口相对 slot 下标 */
function slotOf(localMin: number): number {
  return Math.floor(((localMin - 12 * 60 + 24 * 60) % (24 * 60)) / SLOT_MINUTES)
}

/** 睡眠日窗口 slot → 自然日（00:00 起）对齐的先验下标 */
const PRIOR_OFFSET = SLOT_COUNT / 2

function seedLog(db: Db, source: string, eventType: string, loggedAt: number, payload: Record<string, unknown> = {}) {
  db.insert(behaviorLogs).values({ source, event_type: eventType, payload, logged_at: loggedAt }).run()
}

test('computeDayFeatures：灭屏/交互/静止/桌面活跃占比', () => {
  const { dir, db } = tempDb('basic')
  try {
    // 手机 23:30 灭屏（尾随灭屏延续到窗口末尾 = 次日 12:00）
    seedLog(db, 'android', 'screen_off', at(23 * 60 + 30))
    // 23:35 一次解锁（夜间翻身看手机）
    seedLog(db, 'android', 'screen_unlock', at(23 * 60 + 35))
    // 桌面次日 09:00–09:10 活跃（PC 开机，5s 上报节奏）
    for (let s = 0; s < 600; s += 5) {
      seedLog(db, 'desktop', 'window_focus', at(24 * 60 + 9 * 60) + s, { duration_ms: 5000 })
    }
    // 静止样本 次日 02:00–04:00
    for (let m = 0; m < 120; m += 5) {
      seedLog(db, 'android', 'physical_activity', at(24 * 60 + 2 * 60 + m), { activity_type: 'still', step_count_delta: 0 })
    }

    const f = computeDayFeatures(db, WIN0)

    // slotOf(23:30) = 23:30–24:00：整段灭屏
    const s23 = f.slots[slotOf(23 * 60 + 30)]
    assert.equal(s23.phoneDarkRatio, 1)
    assert.equal(s23.desktopActiveRatio, 0)
    // 23:35 解锁是 STRONG 事件：交互覆盖 [23:35, 23:38] = 3min/30min
    assert.ok(Math.abs(s23.interactionRatio - 3 / 30) < 0.01)
    assert.equal(f.hasPhoneData, true)

    // 次日 02:00–02:30：尾随灭屏 + 全静止，无交互
    const s28 = f.slots[slotOf(24 * 60 + 2 * 60)]
    assert.equal(s28.phoneDarkRatio, 1)
    assert.equal(s28.stillRatio, 1)
    assert.equal(s28.interactionRatio, 0)

    // 次日 09:00–09:30：桌面活跃 ≈ 10min/30min；手机仍灭屏（23:30 后未亮过）
    const s42 = f.slots[slotOf(24 * 60 + 9 * 60)]
    assert.ok(s42.desktopActiveRatio > 0.3 && s42.desktopActiveRatio <= 11 / 30, `桌面活跃占比 ${s42.desktopActiveRatio}`)
    assert.equal(s42.phoneDarkRatio, 1)

    assert.equal(f.slots.length, SLOT_COUNT)
    assert.equal(f.hasStillData, true)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('computeDayFeatures：尾随灭屏延续到窗口末尾', () => {
  const { dir, db } = tempDb('trailing-dark')
  try {
    seedLog(db, 'android', 'screen_off', at(22 * 60))
    const f = computeDayFeatures(db, WIN0)
    assert.equal(f.slots[SLOT_COUNT - 1].phoneDarkRatio, 1)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scoreSlots：先验是同信号下区分白天睡/夜间睡的关键', () => {
  const { dir, db } = tempDb('personalization')
  try {
    // 14:00–15:00 全灭屏 + 全静止 + 无交互（白天睡了一小时）
    seedLog(db, 'android', 'screen_off', at(14 * 60))
    seedLog(db, 'android', 'screen_on', at(15 * 60))
    for (let m = 0; m < 60; m += 5) {
      seedLog(db, 'android', 'physical_activity', at(14 * 60 + m), { activity_type: 'still' })
    }
    const f = computeDayFeatures(db, WIN0)
    const slot = slotOf(14 * 60)
    const zeroPrior = new Array<number>(SLOT_COUNT).fill(0)

    // 夜间睡眠者先验：14:00 的先验（自然日 slot 28）= 0
    const scoreNoPrior = scoreSlots(f, zeroPrior, DEFAULT_SCORE_WEIGHTS, PRIOR_OFFSET)
    // 0.25(灭屏) + 0.30(无交互) + 0.15(静止) = 0.70 → 疑似线，不到候选线 0.9
    assert.ok(Math.abs(scoreNoPrior[slot] - 0.7) < 1e-9, `score=${scoreNoPrior[slot]}`)

    // 白天睡眠者先验：自然日 slot 28 的 prior = 1 → 1.00 ≥ 候选线 0.9
    const dayPrior = new Array<number>(SLOT_COUNT).fill(0)
    dayPrior[28] = 1
    dayPrior[29] = 1
    const scoreWithPrior = scoreSlots(f, dayPrior, DEFAULT_SCORE_WEIGHTS, PRIOR_OFFSET)
    assert.ok(scoreWithPrior[slot] > 0.9, `score=${scoreWithPrior[slot]}`)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scoreSlots：桌面活跃压掉「口袋灭屏」（专利口袋场景的跨端版）', () => {
  const { dir, db } = tempDb('pocket')
  try {
    // 14:00–15:00 手机灭屏放口袋，人在电脑前（桌面 5s 上报节奏）
    seedLog(db, 'android', 'screen_off', at(14 * 60))
    seedLog(db, 'android', 'screen_on', at(15 * 60))
    for (let s = 0; s < 3600; s += 5) {
      seedLog(db, 'desktop', 'window_focus', at(14 * 60) + s, { duration_ms: 5000 })
    }
    const f = computeDayFeatures(db, WIN0)
    const scores = scoreSlots(f, new Array<number>(SLOT_COUNT).fill(0), DEFAULT_SCORE_WEIGHTS, PRIOR_OFFSET)
    // 灭屏项被 (1−桌面活跃) 压为 0；只剩 0.30(无交互) + 0.15×0.5(静止缺失中性) = 0.375
    assert.ok(scores[slotOf(14 * 60)] < 0.5, `口袋+桌面活跃场景得分应明显低于候选线，实际 ${scores[slotOf(14 * 60)]}`)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assembleSleepSegments：间隔 ≤1 个低分 slot 合并，>1 拆段，mainSegment 取最长', () => {
  // 47（睡）、49..50（睡）：48 是 1 个低分间隔 → 应合并为 47..50
  const scores = new Array<number>(SLOT_COUNT).fill(0)
  scores[47] = 0.95
  scores[49] = 0.95
  scores[50] = 0.95
  // 另有一段 10..12，与后续低分间隔 >1 → 独立成段
  scores[10] = 0.95
  scores[11] = 0.9
  scores[12] = 0.92

  const smoothed = smoothScores(scores)
  const segments = assembleSleepSegments(WIN0, smoothed, 0.6, 1)
  const main = mainSegment(segments)!

  assert.equal(main.startSlot, 47)
  assert.equal(main.endSlot, 50)
  assert.equal(main.slotCount, 4)
  assert.equal(segments.length, 2)
})

test('专利「看视频睡着」场景：亮屏无交互段疑似，随后灭屏段达候选，合并为一个睡眠段', () => {
  const { dir, db } = tempDb('video-asleep')
  try {
    // 习惯睡眠带 20:00–05:30（自然日 slot 40–47、0–10）
    const nightPrior = new Array<number>(SLOT_COUNT).fill(0)
    for (let s = 40; s < 48; s++) nightPrior[s] = 1
    for (let s = 0; s <= 10; s++) nightPrior[s] = 1

    // 21:00 亮屏看视频（screen_on 无前导 off → 手机视为亮），无交互、静止
    seedLog(db, 'android', 'screen_on', at(21 * 60))
    // 21:40 睡着，视频结束后灭屏到 05:00；静止样本贯穿 21:00–05:00
    seedLog(db, 'android', 'screen_off', at(21 * 60 + 40))
    for (let m = 21 * 60; m <= 24 * 60 + 5 * 60; m += 5) {
      seedLog(db, 'android', 'physical_activity', at(m), { activity_type: 'still' })
    }
    seedLog(db, 'android', 'screen_on', at(24 * 60 + 5 * 60))
    seedLog(db, 'android', 'screen_unlock', at(24 * 60 + 5 * 60)) // 起床解锁

    const f = computeDayFeatures(db, WIN0)
    const scores = smoothScores(scoreSlots(f, nightPrior, DEFAULT_SCORE_WEIGHTS, PRIOR_OFFSET))

    // 看视频 slot：灭屏 0 → 疑似区间 [0.7, 0.9)
    const videoSlot = slotOf(21 * 60)
    assert.ok(scores[videoSlot] >= 0.7 && scores[videoSlot] < 0.9, `看视频 slot 应落在疑似区间，实际 ${scores[videoSlot]}`)
    // 00:00  slot（灭屏+静止+先验）：≥ 0.9 候选
    assert.ok(scores[slotOf(24 * 60)] >= 0.9, `灭屏 slot 应达候选线，实际 ${scores[slotOf(24 * 60)]}`)

    // 合并：22:00 前后深睡段连成一片，05:00 亮屏止 → 主段覆盖 22:00–04:30
    const segments = assembleSleepSegments(WIN0, scores, 0.9, 1)
    assert.equal(segments.length, 1, `应只有一个睡眠段，实际 ${segments.length}`)
    const main = mainSegment(segments)!
    assert.equal(main.startSlot, slotOf(22 * 60))
    assert.equal(main.endSlot, slotOf(24 * 60 + 4 * 60))
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('全天无手机数据：灭屏/静止按中性 0.5 处理，不主导判断', () => {
  const { dir, db } = tempDb('no-phone-data')
  try {
    const f = computeDayFeatures(db, WIN0)
    assert.equal(f.hasPhoneData, false)
    assert.equal(f.hasStillData, false)
    assert.equal(f.slots[20].phoneDarkRatio, null)
    assert.equal(f.slots[20].stillRatio, null)

    const scores = scoreSlots(f, new Array<number>(SLOT_COUNT).fill(0), DEFAULT_SCORE_WEIGHTS, PRIOR_OFFSET)
    // 0.25×0.5 + 0.30 + 0.15×0.5 = 0.5
    assert.ok(Math.abs(scores[20] - 0.5) < 1e-9)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
