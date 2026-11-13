import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, behaviorLogs, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  getTodaySession,
  getSessionByDate,
  reportSleepStart,
  recordWakeupSession,
  tickSleepStateMachine,
  enterCurfeeByClock,
  type SleepParams,
} from './engine'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'

/**
 * M3 自适应睡眠识别测试：
 * 1. 2026-09-08 事故回归 —— 凌晨入睡 → 上午确认起床 → 12:00 新建 winddown 行
 *    不得被时钟拉回宵禁（起床日期级压制）；到下一次预测入睡点压制过期，宵禁照常。
 * 2. 识别驱动被动候选 —— 有个人先验时，预测睡眠带内的高分 slot 触发候选，
 *    带外同样信号不触发（打分 + 预测窗双闸门）。
 */

const params: SleepParams = {
  sleep_buffer_minutes: 10,
  sleep_confirm_minutes: 15,
  sleep_candidate_idle_minutes: 15,
  sleep_confirm_cooldown_minutes: 30,
  sleep_bright_screen_enabled: true,
}

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-adaptive-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

/** 用户本地日期串：D0=今天 D1=明天…… D_1=昨天（按用户时区） */
const D0 = getUserDateStr(Date.now())
const D1 = getUserDateStr(Date.now() + 86400_000)
const D2 = getUserDateStr(Date.now() + 2 * 86400_000)
const D_1 = getUserDateStr(Date.now() - 86400_000)
const D_2 = getUserDateStr(Date.now() - 2 * 86400_000)
const D_3 = getUserDateStr(Date.now() - 3 * 86400_000)

/** 用户本地 dateStr 的 minutes 分钟时刻 → Unix 秒（minutes 可 >1440 表示次日） */
function t(dateStr: string, minutes: number): number {
  return userZonedTimeToUtc(dateStr, minutes)
}

function seedLog(db: Db, eventType: string, loggedAt: number, payload: Record<string, unknown> = {}, source = 'android') {
  db.insert(behaviorLogs).values({ source, event_type: eventType, payload, logged_at: loggedAt }).run()
}

/**
 * 播种个人节律先验：近三个睡眠日都是 04:00 睡 → 11:45 起
 * （相对睡眠日零点 28:00 → 35:45，slot 8..23，预测带 04:00–12:00）。
 */
function seedPrior(db: Db) {
  for (const date of [D_3, D_2, D_1]) {
    db.insert(circadianLogs).values({
      date,
      sleep_start: t(date, 28 * 60),
      sleep_end: t(date, 35 * 60 + 45),
    }).run()
  }
}

test('事故回归：04:15 入睡 → 11:09 起床 → 12:00 新建 winddown 行不被拉回宵禁 → 次日 04:00 压制过期宵禁照常', () => {
  const { dir, db } = tempDb('incident')
  try {
    seedPrior(db)

    // 04:15 点睡（睡眠日行 D0）
    const tSleep = t(D1, 4 * 60 + 15)
    const s = reportSleepStart(db, tSleep)
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.date, D0)

    // 11:09 确认起床 → 清行 + circadian 落 wakeup_confirmed_at
    const tWake = t(D1, 11 * 60 + 9)
    const w = recordWakeupSession(db, tWake)
    assert.equal(w.phase, 'cleared')
    assert.equal(w.clear_reason, 'wakeup')
    const logRow = db.select().from(circadianLogs).where(eq(circadianLogs.date, D0)).get()
    assert.equal(logRow?.wakeup_confirmed_at, tWake)

    // 12:00:02 跨午：新建 D1 winddown 行，时钟 T0 尝试拉起宵禁 → 必须被起床压制挡下
    const tNoon = t(D1, 12 * 60) + 2
    enterCurfeeByClock(db, tNoon)
    const noonRow = getSessionByDate(db, D1)
    assert.ok(noonRow, '12:00 应已创建 D1 会话行')
    assert.equal(noonRow.phase, 'winddown', '起床后白天不得被时钟拉回宵禁（2026-09-08 事故场景）')

    // 次日 04:00（下一次预测入睡点）：压制过期，宵禁照常拉起
    const tNextBed = t(D2, 4 * 60)
    enterCurfeeByClock(db, tNextBed)
    const nextRow = getSessionByDate(db, D1)
    assert.equal(nextRow.phase, 'curfew', '到预测入睡点压制应过期，当晚宵禁照常')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('识别驱动候选：预测睡眠带内 slot 高分（灭屏+静止+先验）→ confirming；带外同样信号不触发', () => {
  const { dir, db } = tempDb('score-gate')
  try {
    seedPrior(db)

    // 04:10 灭屏；03:30–04:55 连续静止样本（入睡前沿 + slot 33 = 04:30–05:00 全覆盖，
    // 带边缘 slot 的先验被平滑到 0.75，需要 still 补分才能过 0.9 阈值）
    seedLog(db, 'screen_off', t(D1, 4 * 60 + 10))
    for (let m = 3 * 60 + 30; m <= 4 * 60 + 55; m += 5) {
      seedLog(db, 'physical_activity', t(D1, m), { activity_type: 'still' })
    }

    // 04:31 tick（带内）：灭屏 1 × 0.25 + 无交互 0.3 + 静止 0.15 + 先验 0.3 ≈ 1.0 ≥ 0.9 → 候选
    const tIn = t(D1, 4 * 60 + 31)
    tickSleepStateMachine(db, tIn, params, true)
    const sIn = getTodaySession(db, tIn)
    assert.equal(sIn.phase, 'confirming', '预测带内高分 slot 应触发被动候选')
    assert.equal(sIn.candidate_origin_phase, 'winddown')

    // 回 winddown 后，同样信号搬到 14:00（带外，先验 slot 为 0）→ 双闸门挡下
    const { dir: dir2, db: db2 } = tempDb('score-gate-out')
    try {
      seedPrior(db2)
      seedLog(db2, 'screen_off', t(D1, 14 * 60 + 10))
      for (let m = 14 * 60 + 30; m <= 14 * 60 + 55; m += 5) {
        seedLog(db2, 'physical_activity', t(D1, m), { activity_type: 'still' })
      }
      const tOut = t(D1, 14 * 60 + 31)
      tickSleepStateMachine(db2, tOut, params, true)
      const sOut = getTodaySession(db2, tOut)
      assert.equal(sOut.phase, 'winddown', '预测带外即使信号同款也不得触发候选（白天不猜睡）')
    } finally {
      closeDb(db2); fs.rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('冷启动：无先验时沿用旧信号分层（息屏即候选），行为不回归', () => {
  const { dir, db } = tempDb('cold-start')
  try {
    seedLog(db, 'screen_off', t(D1, 4 * 60 + 10))
    const tIn = t(D1, 4 * 60 + 31)
    tickSleepStateMachine(db, tIn, params, true)
    const s = getTodaySession(db, tIn)
    assert.equal(s.phase, 'confirming', '无先验冷启动：息屏信号应照旧触发候选')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('无起床记录时不压制：12:00 winddown 行可被时钟拉回宵禁（未起床场景）', () => {
  const { dir, db } = tempDb('no-wakeup')
  try {
    seedPrior(db)
    // 直接模拟中午的 winddown 行（无起床记录）
    const tNoon = t(D1, 12 * 60) + 2
    getTodaySession(db, tNoon) // 建 D1 winddown 行
    enterCurfeeByClock(db, tNoon)
    // 预测带 04:00–12:00，12:00 已出带 → 时钟本身不会拉（getSunsetPhase 返回 null 时不调用），
    // 这里直接调用 enterCurfeeByClock 验证压制不误伤：无 wakeup 记录 → 正常拉起
    const row = getSessionByDate(db, D1)
    assert.equal(row.phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
