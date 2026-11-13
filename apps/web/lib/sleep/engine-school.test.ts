import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { behaviorLogs, circadianLogs, closeDb, createDb, sunsetSessions } from '@anchor/db'
import { tickSleepStateMachine } from './engine'
import type { SleepParams } from './engine'
import { initSunsetConfig } from '../sunset/config'
import { initSchoolSchedule } from '../school/schedule'
import { userZonedTimeToUtc } from '../time/user-time'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

const PARAMS: SleepParams = {
  sleep_buffer_minutes: 10,
  sleep_confirm_minutes: 15,
  sleep_candidate_idle_minutes: 15,
  sleep_confirm_cooldown_minutes: 30,
  sleep_bright_screen_enabled: true,
}

const MON = '2026-09-07' // 周一
const SLEEP_DATE = '2026-09-06' // 周一 04:00 入睡归属的睡眠日（中午分界）
const MON_10AM = userZonedTimeToUtc(MON, 600)

function initConfigs(db: ReturnType<typeof createDb>): void {
  initSunsetConfig(db)
  initSchoolSchedule(db)
}

function insertSession(db: ReturnType<typeof createDb>, row: Record<string, unknown>): void {
  db.insert(sunsetSessions).values({
    created_at: MON_10AM - 3600,
    updated_at: MON_10AM - 3600,
    ...row,
  } as never).run()
}

function getSession(db: ReturnType<typeof createDb>, date: string) {
  return db.select().from(sunsetSessions).where(eq(sunsetSessions.date, date)).get()
}

test('校时段不产生被动入睡候选（curfew 保持 curfew）', () => {
  const { dir, db } = tempDb('school-no-candidate')
  try {
    initConfigs(db)
    insertSession(db, { date: MON, phase: 'curfew' })
    // passiveWindowActive=true 模拟撞上时钟 T0（phantom 场景）；校时段闸门应拦下候选
    tickSleepStateMachine(db, MON_10AM, PARAMS, true)
    assert.equal(getSession(db, MON)?.phase, 'curfew')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('非校时段同场景仍进入 confirming（闸门不影响夜间正常路径）', () => {
  const { dir, db } = tempDb('school-no-candidate-night')
  try {
    initConfigs(db)
    insertSession(db, { date: MON, phase: 'curfew' })
    tickSleepStateMachine(db, userZonedTimeToUtc(MON, 1200), PARAMS, true) // 20:00
    assert.equal(getSession(db, MON)?.phase, 'confirming')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('校时段作废进行中的非 sleeping 候选（回来源相位，不裁入睡）', () => {
  const { dir, db } = tempDb('school-cancel-confirming')
  try {
    initConfigs(db)
    const candidateSince = MON_10AM - 900
    insertSession(db, {
      date: MON,
      phase: 'confirming',
      candidate_started_at: candidateSince,
      candidate_origin_phase: 'curfew',
      confirm_requested_at: candidateSince,
    })
    // 无校闸时此刻已超 15min 确认窗口 → 会裁成 sleeping；校闸应直接作废候选
    tickSleepStateMachine(db, MON_10AM, PARAMS, true)
    const s = getSession(db, MON)
    assert.equal(s?.phase, 'curfew')
    assert.equal(s?.candidate_started_at, null)
    assert.equal(s?.sleep_start_at, null)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上学日过起床估算点且入睡后零活动 → school_departure 结算并写 sleep_end', () => {
  const { dir, db } = tempDb('school-departure')
  try {
    initConfigs(db)
    const sleepStart = userZonedTimeToUtc(MON, 240) // 04:00 入睡
    const wakeEst = userZonedTimeToUtc(MON, 410) // 06:50 起床估算
    insertSession(db, { date: SLEEP_DATE, phase: 'sleeping', sleep_start_at: sleepStart, last_awake_at: sleepStart })
    db.insert(circadianLogs).values({ date: SLEEP_DATE, sleep_start: sleepStart, meals_count: 0, left_room_count: 0 }).run()

    tickSleepStateMachine(db, userZonedTimeToUtc(MON, 450), PARAMS, false) // 07:30

    const s = getSession(db, SLEEP_DATE)
    assert.equal(s?.phase, 'cleared')
    assert.equal(s?.clear_reason, 'school_departure')

    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, SLEEP_DATE)).get()
    assert.equal(circ?.sleep_end, wakeEst)
    // 睡眠 04:00→06:50 = 2.83h，债务 ≈ 5.17h
    assert.ok(circ?.sleep_debt_hours != null && Math.abs(circ.sleep_debt_hours - (8 - 10200 / 3600)) < 0.01)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上学日但入睡后有晨间活动 → 不按 school_departure 结算（正常唤醒路径）', () => {
  const { dir, db } = tempDb('school-departure-activity')
  try {
    initConfigs(db)
    const sleepStart = userZonedTimeToUtc(MON, 240)
    insertSession(db, { date: SLEEP_DATE, phase: 'sleeping', sleep_start_at: sleepStart, last_awake_at: sleepStart })
    // 06:55 有真实交互（闹钟/摸手机）→ 不是「没带设备出门」
    db.insert(behaviorLogs).values({
      source: 'android', event_type: 'screen_unlock',
      payload: {}, logged_at: userZonedTimeToUtc(MON, 415),
    }).run()

    tickSleepStateMachine(db, userZonedTimeToUtc(MON, 450), PARAMS, false)

    const s = getSession(db, SLEEP_DATE)
    assert.notEqual(s?.phase, 'cleared')
    assert.equal(s?.clear_reason, null)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('非上学日过起床估算点不结算（周末睡懒觉留给 8h 自动解除）', () => {
  const { dir, db } = tempDb('school-departure-weekend')
  try {
    initConfigs(db)
    const SAT = '2026-09-05'
    const SLEEP_DATE_FRI = '2026-09-04'
    const sleepStart = userZonedTimeToUtc(SAT, 250) // 周六 04:10 入睡
    insertSession(db, { date: SLEEP_DATE_FRI, phase: 'sleeping', sleep_start_at: sleepStart, last_awake_at: sleepStart })

    tickSleepStateMachine(db, userZonedTimeToUtc(SAT, 600), PARAMS, false) // 周六 10:00

    const s = getSession(db, SLEEP_DATE_FRI)
    assert.equal(s?.phase, 'sleeping') // 未结算、未确认，继续睡
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
