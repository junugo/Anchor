import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, behaviorLogs, interventionLogs, stateSegments, sunsetConfig, sunsetSessions } from '@anchor/db'
import type { UserState } from '@anchor/types'
import { dayBounds, getTimelineDay, getTimelineDays } from './queries'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-tlq-'))
  return createDb(path.join(dir, 'anchor.db'))
}

// 用本地时区构造日期边界（与 dayBounds 实现一致）
const DATE = '2026-08-10'
const { startS, endS } = dayBounds(DATE)

function seg(db: ReturnType<typeof tempDb>, state: UserState, start: number, end: number | null, source: 'realtime' | 'backfill' = 'realtime') {
  db.insert(stateSegments).values({ state, started_at: start, ended_at: end, source }).run()
}

test('dayBounds 返回本地午夜起的 86400 秒', () => {
  const b = dayBounds(DATE)
  assert.equal(b.endS - b.startS, 86400)
  assert.equal(new Date(b.startS * 1000).getHours(), 0)
})

test('分段裁切到当日边界，跨午夜段只保留当日部分', () => {
  const db = tempDb()
  try {
    seg(db, 'sleeping', startS - 3600, startS + 6 * 3600) // 前一日 23 点睡到 6 点
    seg(db, 'working', startS + 9 * 3600, startS + 12 * 3600)
    const data = getTimelineDay(db, DATE, endS + 1) // nowS 传 dayEnd 之后 → 不裁 now
    assert.equal(data.segments.length, 2)
    assert.equal(data.segments[0].state, 'sleeping')
    assert.equal(data.segments[0].start_time, startS)
    assert.equal(data.segments[0].end_time, startS + 6 * 3600)
    assert.equal(data.segments[1].state, 'working')
  } finally { closeDb(db) }
})

test('open 段（ended_at NULL）闭合到有效末端', () => {
  const db = tempDb()
  try {
    seg(db, 'working', startS + 10 * 3600, null)
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.equal(data.segments.length, 1)
    assert.equal(data.segments[0].end_time, endS)
  } finally { closeDb(db) }
})

test('summary 聚合各状态秒数与干预计数', () => {
  const db = tempDb()
  try {
    seg(db, 'working', startS + 9 * 3600, startS + 12 * 3600) // 3h
    seg(db, 'entertaining', startS + 14 * 3600, startS + 15 * 3600) // 1h
    db.insert(interventionLogs).values({ intervention_id: 'a', dispatched_at: startS + 14 * 3600, action: 'android:push_notify', level: 'notify', state: 'entertaining', trigger_reason: '轻度娱乐', friction_form_id: null, result: 'executed' }).run()
    db.insert(interventionLogs).values({ intervention_id: 'b', dispatched_at: startS + 15 * 3600, action: 'chrome:grayscale', level: 'soft', state: 'entertaining', trigger_reason: '深度娱乐', friction_form_id: null, result: null }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.equal(data.summary.state_seconds['working'], 3 * 3600)
    assert.equal(data.summary.state_seconds['entertaining'], 3600)
    assert.equal(data.summary.intervention_total, 2)
    assert.equal(data.summary.intervention_by_level['notify'], 1)
    assert.equal(data.summary.intervention_by_level['soft'], 1)
  } finally { closeDb(db) }
})

test('事件流水包含干预、入睡/起床标记与宵禁破戒', () => {
  const db = tempDb()
  try {
    db.insert(interventionLogs).values({ intervention_id: 'a', dispatched_at: startS + 14 * 3600, action: 'android:push_notify', level: 'notify', state: 'entertaining', trigger_reason: '轻度娱乐', friction_form_id: null, result: 'dismissed' }).run()
    db.insert(sunsetSessions).values({
      date: '2026-08-09', phase: 'cleared',
      sleep_start_at: startS + 30, cleared_at: startS + 7 * 3600, clear_reason: 'wakeup',
      created_at: startS - 3600, updated_at: startS + 7 * 3600,
    }).run()
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'curfew_breach', payload: { reason: 'force' }, logged_at: startS + 23 * 3600 }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    const kinds = data.events.map(e => e.kind)
    assert.ok(kinds.includes('intervention'))
    assert.ok(kinds.includes('sleep_start'))
    assert.ok(kinds.includes('wakeup'))
    assert.ok(kinds.includes('curfew_breach'))
    // 按时间升序
    const times = data.events.map(e => e.time)
    assert.deepEqual(times, [...times].sort((a, b) => a - b))
  } finally { closeDb(db) }
})

test('hourly_density 归一化到 0..1，hourly_dominant 取覆盖时长最长状态', () => {
  const db = tempDb()
  try {
    seg(db, 'working', startS + 9 * 3600, startS + 11 * 3600)
    for (let i = 0; i < 10; i++) {
      db.insert(behaviorLogs).values({ source: 'desktop', event_type: 'window_focus', payload: {}, logged_at: startS + 9 * 3600 + i * 60 }).run()
    }
    db.insert(behaviorLogs).values({ source: 'desktop', event_type: 'window_focus', payload: {}, logged_at: startS + 15 * 3600 }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.equal(data.hourly_density.length, 24)
    assert.equal(data.hourly_density[9], 1) // 最大值归一为 1
    assert.ok(data.hourly_density[15] < 1)
    assert.equal(data.hourly_density[3], 0)
    assert.equal(data.hourly_dominant[9], 'working')
    assert.equal(data.hourly_dominant[3], null)
  } finally { closeDb(db) }
})

test('getTimelineDays 返回每日迷你色条（fraction 按 86400 占比）', () => {
  const db = tempDb()
  try {
    seg(db, 'working', startS + 9 * 3600, startS + 21 * 3600) // 12h = 0.5
    const days = getTimelineDays(db, DATE, DATE)
    assert.equal(days.length, 1)
    assert.equal(days[0].date, DATE)
    assert.equal(days[0].has_data, true)
    assert.equal(days[0].strips.length, 1)
    assert.equal(days[0].strips[0].state, 'working')
    assert.ok(Math.abs(days[0].strips[0].fraction - 0.5) < 1e-6)
    // 无数据日
    const empty = getTimelineDays(db, '2020-01-01', '2020-01-01')
    assert.equal(empty[0].has_data, false)
    assert.equal(empty[0].strips.length, 0)
  } finally { closeDb(db) }
})

test('宵禁启用且无会话时返回计划 8h 宵禁窗口', () => {
  const db = tempDb()
  try {
    db.insert(sunsetConfig).values({ enabled: true, target_bedtime_minutes: 90, updated_at: 1 }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.deepEqual(data.curfew_window, { start: startS + 90 * 60, end: startS + 90 * 60 + 8 * 3600 })
  } finally { closeDb(db) }
})

test('会话睡眠窗口覆盖推断段（权威睡眠时间），统计随之重算', () => {
  const db = tempDb()
  try {
    // 推断段：03:00-08:00 被误记为 working（确认抖动伤疤）
    seg(db, 'working', startS + 3 * 3600, startS + 8 * 3600)
    // 会话：03:41 入睡，08:47 起床（wakeup）——权威睡眠时间
    db.insert(sunsetSessions).values({
      date: '2026-08-09', phase: 'cleared',
      sleep_start_at: startS + 3 * 3600 + 41 * 60,
      cleared_at: startS + 8 * 3600 + 47 * 60, clear_reason: 'wakeup',
      created_at: startS - 3600, updated_at: startS + 8 * 3600 + 47 * 60,
    }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    const sleeping = data.segments.filter(s => s.state === 'sleeping')
    assert.equal(sleeping.length, 1)
    assert.equal(sleeping[0].start_time, startS + 3 * 3600 + 41 * 60)
    assert.equal(sleeping[0].end_time, startS + 8 * 3600 + 47 * 60)
    assert.equal(sleeping[0].source, 'session')
    // working 段被切掉睡眠窗口：只剩 03:00-03:41 碎片（窗口终点 08:47 超出原段 08:00，无尾部）
    assert.equal(data.summary.state_seconds['working'], 41 * 60)
    assert.equal(data.summary.state_seconds['sleeping'], (8 * 3600 + 47 * 60) - (3 * 3600 + 41 * 60))
    // 主导状态同步校准：05 点整落在睡眠窗口内
    assert.equal(data.hourly_dominant[5], 'sleeping')
  } finally { closeDb(db) }
})

test('宵禁窗口终点跟随会话入睡时刻；早睡于宵禁则当晚无宵禁', () => {
  // 晚睡：05:30 入睡，晚于 04:00 宵禁 → 窗口 04:00→05:30
  const db = tempDb()
  try {
    db.insert(sunsetConfig).values({ enabled: true, target_bedtime_minutes: 4 * 60, updated_at: 1 }).run()
    db.insert(sunsetSessions).values({
      date: '2026-08-09', phase: 'cleared',
      sleep_start_at: startS + 5 * 3600 + 30 * 60, cleared_at: startS + 13 * 3600, clear_reason: 'auto_8h',
      created_at: startS - 3600, updated_at: startS + 13 * 3600,
    }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.deepEqual(data.curfew_window, { start: startS + 4 * 3600, end: startS + 5 * 3600 + 30 * 60 })
    assert.ok(data.events.some(e => e.kind === 'curfew_start'))
  } finally { closeDb(db) }

  // 早睡：03:41 入睡，早于 04:00 宵禁 → 当晚未进入宵禁，不画窗口也不出事件
  const db2 = tempDb()
  try {
    db2.insert(sunsetConfig).values({ enabled: true, target_bedtime_minutes: 4 * 60, updated_at: 1 }).run()
    db2.insert(sunsetSessions).values({
      date: '2026-08-09', phase: 'cleared',
      sleep_start_at: startS + 3 * 3600 + 41 * 60, cleared_at: startS + 8 * 3600 + 47 * 60, clear_reason: 'wakeup',
      created_at: startS - 3600, updated_at: startS + 8 * 3600 + 47 * 60,
    }).run()
    const data = getTimelineDay(db2, DATE, endS + 1)
    assert.equal(data.curfew_window, null)
    assert.ok(!data.events.some(e => e.kind === 'curfew_start'))
  } finally { closeDb(db2) }
})

test('hourly_density 不计睡眠哨兵日志（state_inference）', () => {
  const db = tempDb()
  try {
    for (let i = 0; i < 20; i++) {
      db.insert(behaviorLogs).values({ source: 'web', event_type: 'state_inference', payload: { state: 'sleeping' }, inferred_state: 'sleeping', logged_at: startS + 5 * 3600 + i * 60 }).run()
    }
    db.insert(behaviorLogs).values({ source: 'desktop', event_type: 'window_focus', payload: {}, logged_at: startS + 9 * 3600 }).run()
    const data = getTimelineDay(db, DATE, endS + 1)
    assert.equal(data.hourly_density[5], 0) // 哨兵不算行为事件
    assert.equal(data.hourly_density[9], 1) // 唯一真实事件归一为 1
  } finally { closeDb(db) }
})
