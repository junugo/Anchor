import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import type { FeatureSnapshot, InferenceResult } from '@anchor/types'
import { planInterventions } from './intervention-planner'
import { createDb, closeDb } from '@anchor/db'
import * as schema from '@anchor/db'
import { tempDbPath } from '../testUtils'

function makeDb() {
  const { dir, dbPath } = tempDbPath('planner')
  const db = createDb(dbPath)
  // 返回 db 和清理函数
  return { db, cleanup: () => { closeDb(db); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const NOW_S = 1781956800
const NOW_MS = NOW_S * 1000

function snapshot(partial: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    window_start: NOW_S - 600, window_end: NOW_S, is_lightweight: true,
    code_active_count: 0, deep_work_duration_ms: 0, work_momentum_score: 0,
    work_app_duration_ms: 0, work_visit_count: 0, android_in_work_app: false,
    high_stimulus_visit_count: 0, entertainment_depth_score: 0, attention_fragmentation_score: 0,
    tab_explosion: false, android_unlock_rate: 0,
    android_fun_app_current: false, android_physical_activity: 'unknown',
    do_not_disturb: false, is_idle: false, event_counts: {}, active_sources: [],
    ...partial,
  }
}

function result(partial: Partial<InferenceResult> & { state: InferenceResult['state'] }): InferenceResult {
  return {
    state: partial.state,
    confidence: partial.confidence ?? 0.9,
    evidence: partial.evidence ?? [],
    previous_state: partial.previous_state ?? 'transitioning',
    state_changed: partial.state_changed ?? true,
    do_not_disturb: partial.do_not_disturb ?? false,
    needs_ai_arbitration: partial.needs_ai_arbitration ?? false,
    snapshot: partial.snapshot ?? snapshot(),
  }
}

// 不在宵禁时段的上下文
const NOT_SUNSET = { nowMs: NOW_MS, isSunsetWindow: false, minutesAfterBedtime: -120 }

test('fragmentation dissociation produces soft chrome intervention (no split hard branch)', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'dissociating', snapshot: snapshot({ attention_fragmentation_score: 0.9 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    // 跨端分裂 hard 分支已移除：解离只剩碎片化/解锁两路 soft 干预
    assert.ok(plans.every(p => p.type !== 'hard'))
    assert.ok(plans.some(p => p.type === 'soft' && p.action === 'chrome:grayscale'))
  } finally { cleanup() }
})

test('browser fragmentation dissociation produces soft chrome intervention', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'dissociating', snapshot: snapshot({ attention_fragmentation_score: 0.9 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.some(p => p.type === 'soft' && p.action === 'chrome:grayscale'))
  } finally { cleanup() }
})

test('browser fragmentation dissociation plans include attention_drift frictionFormId', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'dissociating', snapshot: snapshot({ attention_fragmentation_score: 0.9 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    const grayscalePlan = plans.find(p => p.action === 'chrome:grayscale')
    assert.ok(grayscalePlan, '应有 chrome:grayscale 计划')
    assert.ok(typeof grayscalePlan.frictionFormId === 'string', '应有 attention_drift frictionFormId')
  } finally { cleanup() }
})

test('entertaining in sunset window produces hard block', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'entertaining', snapshot: snapshot({ entertainment_depth_score: 0.7 }) })
    const plans = planInterventions(db, r, { nowMs: NOW_MS, isSunsetWindow: true, minutesAfterBedtime: 10 })
    assert.ok(plans.some(p => p.type === 'hard' && p.action === 'chrome:hard_block'))
  } finally { cleanup() }
})

test('working over 90min produces notify rest reminder', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'working', snapshot: snapshot({ deep_work_duration_ms: 95 * 60 * 1000 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.some(p => p.type === 'notify' && p.action === 'desktop:toast_notify'))
  } finally { cleanup() }
})

test('resting 60min after bedtime triggers hard sunset', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'resting', snapshot: snapshot({ is_idle: true }) })
    const plans = planInterventions(db, r, { nowMs: NOW_MS, isSunsetWindow: true, minutesAfterBedtime: 65 })
    assert.ok(plans.some(p => p.action === 'desktop:force_lock'))
  } finally { cleanup() }
})

test('resting 60min after bedtime plans include curfew frictionFormId', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'resting', snapshot: snapshot({ is_idle: true }) })
    const plans = planInterventions(db, r, { nowMs: NOW_MS, isSunsetWindow: true, minutesAfterBedtime: 65 })
    const lockPlan = plans.find(p => p.action === 'desktop:force_lock')
    assert.ok(lockPlan, '应有 force_lock 计划')
    assert.ok(typeof lockPlan.frictionFormId === 'string', '应有 curfew frictionFormId')
  } finally { cleanup() }
})

test('resting 15min after bedtime plans include curfew frictionFormId', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'resting', snapshot: snapshot({ is_idle: true }) })
    const plans = planInterventions(db, r, { nowMs: NOW_MS, isSunsetWindow: true, minutesAfterBedtime: 15 })
    assert.ok(plans.length > 0, '应有干预计划')
    assert.ok(plans.every(p => typeof p.frictionFormId === 'string'), '所有宵禁计划应有 frictionFormId')
  } finally { cleanup() }
})

test('each plan has id, expires_at and fallback message', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'dissociating', snapshot: snapshot({ attention_fragmentation_score: 0.9 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.length > 0)
    for (const p of plans) {
      assert.ok(p.id.length > 0)
      assert.ok(p.expires_at > NOW_S)
      assert.ok(p.message && p.message.length > 0)
    }
  } finally { cleanup() }
})

test('entertaining while previously working uses standard ladder (light = notify, no hard)', () => {
  const { db, cleanup } = makeDb()
  try {
    // 工作中打开娱乐软件 = 简单分心：走标准娱乐摩擦阶梯，轻度只发 notify，无 hard
    const r = result({ state: 'entertaining', previous_state: 'working', snapshot: snapshot({ android_fun_app_current: true, entertainment_depth_score: 0.3 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.length > 0)
    assert.ok(plans.every(p => p.type === 'notify'))
    assert.ok(plans.every(p => !p.action.includes('fullscreen_block')))
  } finally { cleanup() }
})

test('no intervention for plain working under 90min', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'working', snapshot: snapshot({ code_active_count: 4 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.equal(plans.length, 0)
  } finally { cleanup() }
})

test('dissociating with high android_unlock_rate produces soft modal', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'dissociating', snapshot: snapshot({ android_unlock_rate: 18 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.some(p => p.type === 'soft' && p.action === 'android:fullscreen_modal'))
  } finally { cleanup() }
})

test('entertaining with depth > 0.8 non-sunset produces soft grayscale', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'entertaining', snapshot: snapshot({ entertainment_depth_score: 0.85 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.some(p => p.type === 'soft' && p.action === 'chrome:grayscale'))
    assert.ok(plans.some(p => p.type === 'soft' && p.action === 'android:fullscreen_modal'))
  } finally { cleanup() }
})

test('entertaining with low depth non-sunset produces notify friction', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'entertaining', snapshot: snapshot({ entertainment_depth_score: 0.3 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    assert.ok(plans.some(p => p.type === 'notify' && p.action === 'chrome:friction_banner'))
    assert.ok(plans.some(p => p.type === 'notify' && p.action === 'android:push_notify'))
  } finally { cleanup() }
})

test('entertaining plans include frictionFormId from habituation selection', () => {
  const { db, cleanup } = makeDb()
  try {
    const r = result({ state: 'entertaining', snapshot: snapshot({ entertainment_depth_score: 0.3 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    // 全新 db 无习惯化记录，应选择第一个形式
    const chromeplan = plans.find(p => p.action === 'chrome:friction_banner')
    assert.ok(chromeplan, '应有 chrome:friction_banner 计划')
    assert.ok(typeof chromeplan.frictionFormId === 'string', 'frictionFormId 应为字符串')
    assert.ok(chromeplan.frictionFormId!.length > 0, 'frictionFormId 不应为空字符串')
  } finally { cleanup() }
})

test('when all entertainment forms habituated plan level escalates to hard', () => {
  const { db, cleanup } = makeDb()
  try {
    // 预先向每个 entertainment 形式注入 5 对快速绕过事件（<10秒）
    const formIds = [
      'entertainment:long_press_3s',
      'entertainment:confirm_dialog',
      'entertainment:show_usage_time',
      'entertainment:type_confirm',
    ]
    const now = Math.floor(Date.now() / 1000)
    for (const fid of formIds) {
      for (let i = 0; i < 5; i++) {
        const t = now - (5 - i) * 30
        db.insert(schema.frictionEvents).values({ form_id: fid, event_type: 'triggered', context: {}, recorded_at: t }).run()
        db.insert(schema.frictionEvents).values({ form_id: fid, event_type: 'bypassed', context: {}, recorded_at: t + 3 }).run()
      }
    }

    // depth > 0.8 → 基础等级 soft，全部习惯化后应升级到 hard
    const r = result({ state: 'entertaining', snapshot: snapshot({ entertainment_depth_score: 0.9 }) })
    const plans = planInterventions(db, r, NOT_SUNSET)
    // 全部形式已习惯化 → 升级到 hard
    assert.ok(plans.some(p => p.type === 'hard'), '全部形式习惯化后应升级到 hard')
  } finally { cleanup() }
})
