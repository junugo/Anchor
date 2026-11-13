import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, behaviorLogs, sunsetSessions, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  getTodaySession,
  reportSleepStart,
  recordWakeupSession,
  respondSleepConfirm,
  respondWakeConfirm,
  tickSleepStateMachine,
  enterCurfeeByClock,
  computeCurrentSunsetStage,
  sessionBlocksTimeCurfew,
  sessionDateKey,
  type SleepParams,
} from './engine'

const params: SleepParams = {
  sleep_buffer_minutes: 10,
  sleep_confirm_minutes: 15,
  sleep_candidate_idle_minutes: 15,
  sleep_confirm_cooldown_minutes: 30,
  sleep_bright_screen_enabled: true,
}

const paramsBrightOff: SleepParams = {
  ...params,
  sleep_bright_screen_enabled: false,
}

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-sleep-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

// 固定基准时间：某晚 23:00（避免跨午夜归属影响断言）
const BASE = new Date()
BASE.setHours(23, 0, 0, 0)
const T0 = Math.floor(BASE.getTime() / 1000)

function seedLog(db: Db, eventType: string, loggedAt: number, payload: Record<string, unknown> = {}) {
  db.insert(behaviorLogs).values({
    source: 'android',
    event_type: eventType,
    payload,
    logged_at: loggedAt,
  }).run()
}

const DATE = sessionDateKey(T0 * 1000)

test('点「睡了」→ 直接 sleeping，sleep_start=点击时间', () => {
  const { dir, db } = tempDb('manual-sleep')
  try {
    enterCurfeeByClock(db, T0)
    const s = reportSleepStart(db, T0 + 600) // 23:10 点睡
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.sleep_start_at, T0 + 600)
    assert.equal(s.sleep_start_reported_at, T0 + 600)
    assert.equal(computeCurrentSunsetStage(db, null, T0 + 600).stage, 'T0')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('场景 C：点睡后无活跃信号，保持 sleeping，sleep_start 不变', () => {
  const { dir, db } = tempDb('no-activity')
  try {
    reportSleepStart(db, T0)
    tickSleepStateMachine(db, T0 + 600, params)
    const s = getTodaySession(db, T0 + 600)
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.sleep_start_at, T0)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('场景 B：点睡后强活动 → wake_observing；观察窗内第二个强活动 → 确认起床', () => {
  const { dir, db } = tempDb('click-then-active')
  try {
    reportSleepStart(db, T0) // 23:00 点睡
    seedLog(db, 'screen_unlock', T0 + 700) // 23:11 刷手机（强活动）
    // 冷却外（confirm_requested_at 为 null）→ 进入 wake_observing
    tickSleepStateMachine(db, T0 + 700, params)
    let s = getTodaySession(db, T0 + 700)
    assert.equal(s.phase, 'wake_observing')
    assert.equal(s.wake_first_activity_at, T0 + 700)
    assert.equal(s.wake_observe_until_at, T0 + 700 + 30 * 60) // 入睡 <3h，30min 窗

    // 30min 观察窗内第二个强活动 → 确认起床（sleep_end=首个活动时刻）
    seedLog(db, 'screen_unlock', T0 + 700 + 60) // 23:12 第二个强活动
    tickSleepStateMachine(db, T0 + 700 + 60, params, false, 'T0') // clockPhase=T0（深夜在宵禁带内）→ 回 curfee
    s = getTodaySession(db, T0 + 700 + 60)
    assert.equal(s.phase, 'curfew') // 23:12 仍在 T0 带内 → 回 curfee
    assert.equal(s.sleep_start_at, null) // 本轮睡眠已结束（sleep_end 已落库），清 sleep_start 让时钟兜底可生效
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, DATE)).get()
    assert.equal(circ?.sleep_end, T0 + 700) // sleep_end = 首个强活动时刻
    assert.equal(circ?.wakeup_confirmed_at != null, true)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('防抖动：观察窗超时返回 sleeping 后 last_awake_at 推进，陈旧活动不再重复触发观察窗', () => {
  const { dir, db } = tempDb('stale-activity')
  try {
    reportSleepStart(db, T0) // 23:00 点睡
    seedLog(db, 'screen_unlock', T0 + 700) // 23:11 刷手机（强活动）→ 触发 wake_observing
    tickSleepStateMachine(db, T0 + 700, params)
    assert.equal(getTodaySession(db, T0 + 700).phase, 'wake_observing')

    // 30min 观察窗超时无第二个强活动 → 回 sleeping：入睡时间不变，last_awake_at 推进到超时时刻
    const timeoutAt = T0 + 700 + 30 * 60 + 1
    tickSleepStateMachine(db, timeoutAt, params)
    let s = getTodaySession(db, timeoutAt)
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.sleep_start_at, T0)
    assert.equal(s.last_awake_at, timeoutAt)
    assert.equal(s.confirm_requested_at, timeoutAt) // 冷却起算

    // 冷却 30min 内：23:11 的旧解锁事件不得再次触发观察窗
    tickSleepStateMachine(db, timeoutAt + 60, params)
    s = getTodaySession(db, timeoutAt + 60)
    assert.equal(s.phase, 'sleeping')

    // 冷却结束后的真实新活动可触发观察窗
    seedLog(db, 'screen_unlock', timeoutAt + 31 * 60)
    tickSleepStateMachine(db, timeoutAt + 31 * 60, params)
    assert.equal(getTodaySession(db, timeoutAt + 31 * 60).phase, 'wake_observing')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('wake_observing 中用户点「我醒了」→ 回 curfew（T0 带内），sleep_end=首个活动时刻，wakeup_confirmed_at 落库', () => {
  const { dir, db } = tempDb('click-then-woke')
  try {
    reportSleepStart(db, T0) // 23:00 点睡
    db.insert(circadianLogs).values({ date: DATE, sleep_start: T0, meals_count: 0, left_room_count: 0 }).run()
    seedLog(db, 'screen_unlock', T0 + 700) // 23:11 强活动 → wake_observing
    tickSleepStateMachine(db, T0 + 700, params)
    assert.equal(getTodaySession(db, T0 + 700).phase, 'wake_observing')

    const respondAt = T0 + 800
    const s = respondWakeConfirm(db, respondAt, true, 'T0') // 点「我醒了」，时钟在 T0 带内
    assert.equal(s.phase, 'curfew') // 回宵禁窗口，干预照常
    assert.equal(s.last_awake_at, respondAt)
    assert.equal(s.wake_first_activity_at, null)
    assert.equal(s.wake_observe_until_at, null)
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, DATE)).get()
    assert.equal(circ?.sleep_end, T0 + 700) // sleep_end = 首个强活动时刻
    assert.equal(circ?.wakeup_confirmed_at, respondAt)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('wake_observing 中点「还没睡」/取消（confirmed=false）→ 仅关弹窗，相位不变', () => {
  const { dir, db } = tempDb('woke-dismiss')
  try {
    reportSleepStart(db, T0)
    seedLog(db, 'screen_unlock', T0 + 700)
    tickSleepStateMachine(db, T0 + 700, params)
    assert.equal(getTodaySession(db, T0 + 700).phase, 'wake_observing')

    const s = respondWakeConfirm(db, T0 + 800, false, 'T0')
    assert.equal(s.phase, 'wake_observing') // 相位不变，等待观察窗自动裁决
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('场景 A：被动候选（screen_off）→ confirming → 超时 → auto-confirm sleeping，sleep_start=候选起点+BUFFER', () => {
  const { dir, db } = tempDb('passive-candidate')
  try {
    enterCurfeeByClock(db, T0)
    // 提前进入 curfew 后，23:10 起无白名单活动，23:20 息屏
    seedLog(db, 'screen_off', T0 + 1200) // 23:20 息屏（候选信号）
    // 候选阈值 15min：idle 窗口从 now-15min 起无活动；23:35 时窗口=23:20~23:35，无活动
    const t = T0 + 35 * 60 // 23:35
    tickSleepStateMachine(db, t, params, true)
    const s = getTodaySession(db, t)
    assert.equal(s.phase, 'confirming')
    assert.equal(s.candidate_started_at, T0 + 1200) // 候选起点 = screen_off 时间

    // 15min 超时 → auto-confirm（确认窗口从询问框广播时刻 t 起算，不是候选起点）
    const timeoutAt = t + params.sleep_confirm_minutes * 60 + 1
    tickSleepStateMachine(db, timeoutAt, params)
    const s2 = getTodaySession(db, timeoutAt)
    assert.equal(s2.phase, 'sleeping')
    assert.equal(s2.sleep_start_at, T0 + 1200 + params.sleep_buffer_minutes * 60)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('场景 A：被动候选中用户点「还没睡」→ 回 curfew，候选作废，进冷却', () => {
  const { dir, db } = tempDb('passive-notyet')
  try {
    enterCurfeeByClock(db, T0)
    seedLog(db, 'screen_off', T0 + 1200)
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'confirming')

    const respondAt = t + 60
    const s = respondSleepConfirm(db, respondAt, params)
    assert.equal(s.phase, 'curfew') // 回 curfew
    assert.equal(s.candidate_started_at, null)
    assert.equal(s.last_awake_at, respondAt)

    // 冷却 30min 内：即使息屏也不再触发候选
    seedLog(db, 'screen_off', respondAt + 60)
    tickSleepStateMachine(db, respondAt + 20 * 60, params, true)
    assert.equal(getTodaySession(db, respondAt + 20 * 60).phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('被动事件不触发候选、不回推', () => {
  const { dir, db } = tempDb('passive-events')
  try {
    enterCurfeeByClock(db, T0)
    // 只有被动/轮询事件，无白名单活动，无 screen_off
    seedLog(db, 'physical_activity', T0 + 200)
    seedLog(db, 'app_usage_snapshot', T0 + 300)
    seedLog(db, 'battery_charging', T0 + 400)
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    const s = getTodaySession(db, t)
    // 完全无白名单活动 → 候选触发（完全无活动路径），candidate = idleThreshold
    assert.equal(s.phase, 'confirming')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('自适应上限：sleep_start_at + 上限到期 → cleared(wakeup_cap)，sleep_end 落库', () => {
  const { dir, db } = tempDb('auto-cap')
  try {
    reportSleepStart(db, T0) // 23:00 睡
    // 无历史记录：上限 = 8h（最小值）；睡满 8h = 次日 07:00
    const wakeAt = T0 + 8 * 60 * 60 + 1
    tickSleepStateMachine(db, wakeAt, params)
    // 跨午夜后 getTodaySession 归属仍是前一晚（小时 <12 → 前一天）
    const s = getSessionByDateSafe(db, DATE)
    assert.equal(s?.phase, 'cleared')
    assert.equal(s?.clear_reason, 'wakeup_cap')
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, DATE)).get()
    assert.equal(circ?.sleep_end, T0 + 8 * 60 * 60) // sleep_end = sleep_start + 8h
    assert.equal(computeCurrentSunsetStage(db, null, wakeAt).stage, 'off')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('自适应上限：睡过 10h 的历史 → 上限涨到 11h', () => {
  const { dir, db } = tempDb('adaptive-cap')
  try {
    // 造一段 10h 的历史睡眠（前天）
    const pastDate = sessionDateKey((T0 - 48 * 3600) * 1000)
    db.insert(circadianLogs).values({
      date: pastDate,
      sleep_start: T0 - 48 * 3600,
      sleep_end: T0 - 48 * 3600 + 10 * 3600,
      meals_count: 0,
      left_room_count: 0,
    }).run()

    reportSleepStart(db, T0) // 23:00 睡
    // 8h 时（07:00）不应触发上限（上限已涨到 11h）
    tickSleepStateMachine(db, T0 + 8 * 3600 + 1, params)
    let s = getSessionByDateSafe(db, DATE)
    assert.equal(s?.phase, 'sleeping')

    // 11h 时（10:00）触发
    tickSleepStateMachine(db, T0 + 11 * 3600 + 1, params)
    s = getSessionByDateSafe(db, DATE)
    assert.equal(s?.phase, 'cleared')
    assert.equal(s?.clear_reason, 'wakeup_cap')
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, DATE)).get()
    assert.equal(circ?.sleep_end, T0 + 11 * 3600)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

function getSessionByDateSafe(db: Db, date: string) {
  return db.select().from(sunsetSessions).where(eq(sunsetSessions.date, date)).get()
}

test('released 压制时间触发；行为触发（点睡）仍可进入 sleeping', () => {
  const { dir, db } = tempDb('released')
  try {
    enterCurfeeByClock(db, T0)
    reportSleepStart(db, T0)
    // 模拟强制解锁
    db.update(sunsetSessions).set({ phase: 'released', clear_reason: 'force', force_release_count: 1 }).where(eq(sunsetSessions.date, DATE)).run()
    let s = getTodaySession(db, T0)
    assert.equal(s.phase, 'released')
    assert.equal(sessionBlocksTimeCurfew(s.phase), true)
    assert.equal(computeCurrentSunsetStage(db, null, T0).stage, 'off')

    // 行为触发：released 下再点「睡了」→ sleeping
    s = reportSleepStart(db, T0 + 3600)
    assert.equal(s.phase, 'sleeping')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('released 下照跑被动候选（B 方案）', () => {
  const { dir, db } = tempDb('released-candidate')
  try {
    enterCurfeeByClock(db, T0)
    db.update(sunsetSessions).set({ phase: 'released', clear_reason: 'force', force_release_count: 1 }).where(eq(sunsetSessions.date, DATE)).run()
    seedLog(db, 'screen_off', T0 + 1200)
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    // released 也跑被动候选 → confirming
    assert.equal(getTodaySession(db, t).phase, 'confirming')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('起床验证 → cleared(wakeup)，压制后续时间触发', () => {
  const { dir, db } = tempDb('wakeup')
  try {
    reportSleepStart(db, T0)
    const s = recordWakeupSession(db, T0 + 7 * 3600)
    assert.equal(s.phase, 'cleared')
    assert.equal(s.clear_reason, 'wakeup')
    assert.equal(sessionBlocksTimeCurfew(s.phase), true)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('兜底：curfew 无 sleep_start_at 且时钟窗口已过 → auto_8h 解除', () => {
  const { dir, db } = tempDb('fallback-clear')
  try {
    enterCurfeeByClock(db, T0)
    // 无 sleep_start_at，时钟窗口已过（clockPhase=null）
    const { session } = computeCurrentSunsetStage(db, null, T0 + 9 * 3600)
    assert.equal(session.phase, 'cleared')
    assert.equal(session.clear_reason, 'auto_8h')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('兜底：有 sleep_start_at 时不走 fallback（由 8h 规则处理）', () => {
  const { dir, db } = tempDb('fallback-skip')
  try {
    reportSleepStart(db, T0)
    // 有 sleep_start_at：computeCurrentSunsetStage 的兜底不清除（8h 解除由 tickSleeping 负责）
    const { session } = computeCurrentSunsetStage(db, null, T0 + 9 * 3600)
    assert.equal(session.phase, 'sleeping')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop 空闲结算 window_focus{is_idle:true} 不算活动，不阻挡入睡候选', () => {
  const { dir, db } = tempDb('idle-settle')
  try {
    enterCurfeeByClock(db, T0)
    // 23:05 用户停止键鼠，desktop 发出最后的空闲结算后静默
    seedLog(db, 'window_focus', T0 + 1200, { process: 'Code.exe', duration_ms: 300000, is_idle: true })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    const s = getTodaySession(db, t)
    // 空闲结算不算活动 → 候选触发（无活动兜底路径），candidate = idleThreshold
    assert.equal(s.phase, 'confirming')
    assert.equal(s.candidate_started_at, t - params.sleep_candidate_idle_minutes * 60)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('正常窗口结算 window_focus{is_idle:false} 仍算活动，阻挡入睡候选', () => {
  const { dir, db } = tempDb('active-settle')
  try {
    enterCurfeeByClock(db, T0)
    seedLog(db, 'window_focus', T0 + 1200, { process: 'Code.exe', duration_ms: 60000, is_idle: false })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('screen_on 不算活动（通知亮屏不阻挡候选）；screen_unlock 仍算活动', () => {
  const { dir, db } = tempDb('screen-on')
  try {
    enterCurfeeByClock(db, T0)
    // 凌晨通知亮屏：screen_on 无解锁 → 不证明醒着
    seedLog(db, 'screen_on', T0 + 1200)
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'confirming')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }

  const { dir: dir2, db: db2 } = tempDb('screen-unlock')
  try {
    enterCurfeeByClock(db2, T0)
    seedLog(db2, 'screen_unlock', T0 + 1200)
    const t = T0 + 35 * 60
    tickSleepStateMachine(db2, t, params, true)
    assert.equal(getTodaySession(db2, t).phase, 'curfew')
  } finally {
    closeDb(db2); fs.rmSync(dir2, { recursive: true, force: true })
  }
})

test('winddown 被动检测窗口内：无活动 → confirming(origin=winddown) → 超时 → sleeping', () => {
  const { dir, db } = tempDb('winddown-candidate')
  try {
    // 会话默认 winddown；23:00 起无任何活动
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    let s = getTodaySession(db, t)
    assert.equal(s.phase, 'confirming')
    assert.equal(s.candidate_origin_phase, 'winddown')
    assert.equal(s.candidate_started_at, t - params.sleep_candidate_idle_minutes * 60)
    // 确认框相位跟随时钟：宵禁视觉不提前
    assert.equal(computeCurrentSunsetStage(db, 'T30', t).stage, 'T30')
    assert.equal(computeCurrentSunsetStage(db, null, t).stage, 'off')

    // 无响应超时 → sleeping，sleep_start = 候选起点 + BUFFER
    const timeoutAt = t + params.sleep_confirm_minutes * 60 + 1
    tickSleepStateMachine(db, timeoutAt, params, true)
    s = getTodaySession(db, timeoutAt)
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.sleep_start_at, t - params.sleep_candidate_idle_minutes * 60 + params.sleep_buffer_minutes * 60)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('winddown 非检测窗口（白天）：无活动也不触发候选', () => {
  const { dir, db } = tempDb('winddown-daytime')
  try {
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, false)
    assert.equal(getTodaySession(db, t).phase, 'winddown')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('confirming(origin=winddown) 点「还没睡」→ 回 winddown，进冷却', () => {
  const { dir, db } = tempDb('winddown-notyet')
  try {
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'confirming')

    const respondAt = t + 60
    const s = respondSleepConfirm(db, respondAt, params)
    assert.equal(s.phase, 'winddown')
    assert.equal(s.candidate_started_at, null)
    assert.equal(s.last_awake_at, respondAt)

    // 冷却 30min 内不再触发候选
    tickSleepStateMachine(db, respondAt + 20 * 60, params, true)
    assert.equal(getTodaySession(db, respondAt + 20 * 60).phase, 'winddown')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('released 检测窗口外（白天）：无活动也不触发候选，不再误判 sleeping', () => {
  const { dir, db } = tempDb('released-daytime')
  try {
    enterCurfeeByClock(db, T0)
    db.update(sunsetSessions).set({ phase: 'released', clear_reason: 'force', force_release_count: 1 }).where(eq(sunsetSessions.date, DATE)).run()
    const t = T0 + 35 * 60
    // passiveWindowActive=false（白天）：released 无闸门时代会在此误判，现在保持 released
    tickSleepStateMachine(db, t, params, false)
    assert.equal(getTodaySession(db, t).phase, 'released')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('兜底：released 无 sleep_start_at 且时钟窗口已过 → auto_8h 解除（不再永久残留）', () => {
  const { dir, db } = tempDb('fallback-released')
  try {
    enterCurfeeByClock(db, T0)
    db.update(sunsetSessions).set({ phase: 'released', clear_reason: 'force', force_release_count: 1 }).where(eq(sunsetSessions.date, DATE)).run()
    const { session } = computeCurrentSunsetStage(db, null, T0 + 9 * 3600)
    assert.equal(session.phase, 'cleared')
    assert.equal(session.clear_reason, 'auto_8h')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('兜底：confirming(origin=released) 时钟窗口已过 → auto_8h 解除', () => {
  const { dir, db } = tempDb('fallback-confirming-released')
  try {
    enterCurfeeByClock(db, T0)
    db.update(sunsetSessions).set({
      phase: 'confirming',
      candidate_origin_phase: 'released',
      candidate_started_at: T0 + 8 * 3600,
      confirm_requested_at: T0 + 8 * 3600,
    }).where(eq(sunsetSessions.date, DATE)).run()
    const { session } = computeCurrentSunsetStage(db, null, T0 + 9 * 3600)
    assert.equal(session.phase, 'cleared')
    assert.equal(session.clear_reason, 'auto_8h')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('兜底：confirming(origin=winddown) 不被兜底清除（就寝前候选受保护）', () => {
  const { dir, db } = tempDb('fallback-confirming-winddown')
  try {
    // winddown 相位的候选出现在就寝前；此处直接构造 origin=winddown 的 confirming
    getTodaySession(db, T0) // 确保当日行存在
    db.update(sunsetSessions).set({
      phase: 'confirming',
      candidate_origin_phase: 'winddown',
      candidate_started_at: T0,
      confirm_requested_at: T0,
    }).where(eq(sunsetSessions.date, DATE)).run()
    const { session } = computeCurrentSunsetStage(db, null, T0 + 600)
    assert.equal(session.phase, 'confirming')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('亮屏静止：只有 app_foreground + physical_activity(still) → 进入 confirming', () => {
  const { dir, db } = tempDb('bright-screen-idle')
  try {
    enterCurfeeByClock(db, T0)
    // 23:20 起手机亮屏放一边：只有轮询心跳，无真实交互
    for (let i = 0; i < 8; i++) {
      seedLog(db, 'app_foreground', T0 + 1200 + i * 60, { packageName: 'com.tencent.mm', appName: 'WeChat' })
    }
    seedLog(db, 'physical_activity', T0 + 1500, { step_count_delta: 0, activity_type: 'still' })
    const t = T0 + 35 * 60 // 23:35
    tickSleepStateMachine(db, t, params, true)
    const s = getTodaySession(db, t)
    assert.equal(s.phase, 'confirming')
    assert.equal(s.candidate_started_at, t - params.sleep_candidate_idle_minutes * 60)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('亮屏静止：有 screen_unlock → 不进入 confirming', () => {
  const { dir, db } = tempDb('bright-screen-unlock')
  try {
    enterCurfeeByClock(db, T0)
    for (let i = 0; i < 8; i++) {
      seedLog(db, 'app_foreground', T0 + 1200 + i * 60, { packageName: 'com.tencent.mm', appName: 'WeChat' })
    }
    seedLog(db, 'screen_unlock', T0 + 1500, { timestamp: T0 + 1500 })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('亮屏静止：有 url_visit → 不进入 confirming', () => {
  const { dir, db } = tempDb('bright-screen-url')
  try {
    enterCurfeeByClock(db, T0)
    for (let i = 0; i < 8; i++) {
      seedLog(db, 'app_foreground', T0 + 1200 + i * 60, { packageName: 'com.tencent.mm', appName: 'WeChat' })
    }
    seedLog(db, 'url_visit', T0 + 1500, { url: 'https://example.com', domain: 'example.com', duration_seconds: 30, high_stimulus: false })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('亮屏静止：确认超时 → 进入 sleeping，sleep_start = idleThreshold + BUFFER', () => {
  const { dir, db } = tempDb('bright-screen-confirm')
  try {
    enterCurfeeByClock(db, T0)
    seedLog(db, 'app_foreground', T0 + 1200, { packageName: 'com.tencent.mm', appName: 'WeChat' })
    seedLog(db, 'physical_activity', T0 + 1500, { step_count_delta: 0, activity_type: 'still' })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, params, true)
    assert.equal(getTodaySession(db, t).phase, 'confirming')

    const timeoutAt = t + params.sleep_confirm_minutes * 60 + 1
    tickSleepStateMachine(db, timeoutAt, params, true)
    const s = getTodaySession(db, timeoutAt)
    assert.equal(s.phase, 'sleeping')
    assert.equal(s.sleep_start_at, t - params.sleep_candidate_idle_minutes * 60 + params.sleep_buffer_minutes * 60)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('亮屏静止：开关关闭 → 不进入 confirming', () => {
  const { dir, db } = tempDb('bright-screen-disabled')
  try {
    enterCurfeeByClock(db, T0)
    for (let i = 0; i < 8; i++) {
      seedLog(db, 'app_foreground', T0 + 1200 + i * 60, { packageName: 'com.tencent.mm', appName: 'WeChat' })
    }
    seedLog(db, 'physical_activity', T0 + 1500, { step_count_delta: 0, activity_type: 'still' })
    const t = T0 + 35 * 60
    tickSleepStateMachine(db, t, paramsBrightOff, true)
    assert.equal(getTodaySession(db, t).phase, 'curfew')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
