import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { InferenceResult, FeatureSnapshot } from '@anchor/types'
import { behaviorLogs, closeDb, createDb } from '@anchor/db'
import { emptyDailyContext, accumulate, recordIntervention, rebuildFromLogs, TICK_INTERVAL_MS } from './daily-context'

const NOW_S = 1781956800

function snap(p: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    window_start: NOW_S - 600, window_end: NOW_S, is_lightweight: false,
    code_active_count: 0, deep_work_duration_ms: 0, work_momentum_score: 0,
    work_app_duration_ms: 0, work_visit_count: 0, android_in_work_app: false,
    high_stimulus_visit_count: 0, entertainment_depth_score: 0, attention_fragmentation_score: 0,
    tab_explosion: false, android_unlock_rate: 0,
    android_fun_app_current: false, android_physical_activity: 'unknown',
    do_not_disturb: false, is_idle: false, event_counts: {}, active_sources: [], ...p,
  }
}

function res(state: InferenceResult['state'], s: Partial<FeatureSnapshot> = {}): InferenceResult {
  return {
    state, confidence: 0.9, evidence: [], previous_state: 'transitioning',
    state_changed: true, do_not_disturb: false, needs_ai_arbitration: false, snapshot: snap(s),
  }
}

test('emptyDailyContext zeroes all counters', () => {
  const c = emptyDailyContext('2026-06-17')
  assert.equal(c.date, '2026-06-17')
  assert.equal(c.deep_work_total_ms, 0)
  assert.equal(c.work_by_hour.length, 24)
  assert.equal(c.distraction_by_hour.every(n => n === 0), true)
})

test('accumulate working adds deep work and bumps hour histogram', () => {
  let c = emptyDailyContext('2026-06-17')
  c = accumulate(c, res('working', { deep_work_duration_ms: 300_000 }), 10) // 10 时
  assert.equal(c.deep_work_total_ms, 300_000)
  assert.equal(c.work_by_hour[10], 1)
})

test('accumulate dissociating counts and records first time', () => {
  let c = emptyDailyContext('2026-06-17')
  c = accumulate(c, res('dissociating'), 14, NOW_S)
  assert.equal(c.dissociation_count, 1)
  assert.equal(c.dissociation_total_ms, TICK_INTERVAL_MS)
  assert.equal(c.first_dissociation_time, NOW_S)
  assert.equal(c.distraction_by_hour[14], 1)
  // 第二次解离不覆盖 first_dissociation_time
  c = accumulate(c, res('dissociating'), 15, NOW_S + 3600)
  assert.equal(c.dissociation_count, 2)
  assert.equal(c.first_dissociation_time, NOW_S)
})

test('accumulate tracks longest deep work session', () => {
  let c = emptyDailyContext('2026-06-17')
  c = accumulate(c, res('working', { deep_work_duration_ms: 200_000 }), 9)
  c = accumulate(c, res('working', { deep_work_duration_ms: 500_000 }), 11)
  assert.equal(c.longest_deep_work_ms, 500_000)
})

test('recordIntervention increments triggered/dismissed', () => {
  let c = emptyDailyContext('2026-06-17')
  c = recordIntervention(c, { dismissed: false, effective: true })
  c = recordIntervention(c, { dismissed: true, effective: false })
  assert.equal(c.interventions_triggered, 2)
  assert.equal(c.interventions_dismissed, 1)
  assert.equal(c.interventions_effective, 1)
})

// ── Task 3：rebuildFromLogs ────────────────────────────────────────────────

test('rebuildFromLogs reconstructs unlock count from screen_unlock events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-rebuild-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const dayStart = 1781913600 // 当日 00:00 unix 秒
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_unlock', payload: { unlock_count_today: 3 }, logged_at: dayStart + 100 }).run()
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_unlock', payload: { unlock_count_today: 7 }, logged_at: dayStart + 200 }).run()
    const c = rebuildFromLogs(db, '2026-06-17', dayStart)
    // 取当日最大 unlock_count_today
    assert.equal(c.android_unlock_count, 7)
    // android_screen_on_total_ms 目前不从 behavior_logs 重建，应为 0
    assert.equal(c.android_screen_on_total_ms, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuildFromLogs also reads unlock_count_today from screen_on events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-rebuild-screen-on-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const dayStart = 1781913600
    // screen_on 事件同样携带 unlock_count_today，rebuildFromLogs 应取最大值
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_on', payload: { unlock_count_today: 5 }, logged_at: dayStart + 50 }).run()
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_on', payload: { unlock_count_today: 10 }, logged_at: dayStart + 150 }).run()
    const c = rebuildFromLogs(db, '2026-06-17', dayStart)
    assert.equal(c.android_unlock_count, 10)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuildFromLogs with no logs returns zero android_unlock_count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-rebuild-empty-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const dayStart = 1781913600
    // 当日无任何行为日志，android_unlock_count 应为 0
    const c = rebuildFromLogs(db, '2026-06-17', dayStart)
    assert.equal(c.android_unlock_count, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuildFromLogs excludes events from next day (upper bound check)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-rebuild-upperbound-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const dayStart = 1781913600 // 当日 00:00
    const dayEnd = dayStart + 86400   // 次日 00:00
    // 次日事件，应被 lt(dayEnd) 过滤掉
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_unlock', payload: { unlock_count_today: 99 }, logged_at: dayEnd }).run()
    db.insert(behaviorLogs).values({ source: 'android', event_type: 'screen_unlock', payload: { unlock_count_today: 3 }, logged_at: dayStart + 100 }).run()
    const c = rebuildFromLogs(db, '2026-06-17', dayStart)
    // 次日的 99 应被排除，只取当日的 3
    assert.equal(c.android_unlock_count, 3)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
