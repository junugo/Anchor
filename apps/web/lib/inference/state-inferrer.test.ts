import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeatureSnapshot } from '@anchor/types'
import { inferState } from './state-inferrer'

const NOW_S = 1781956800

// 全 0 的基准快照工厂
function snapshot(partial: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    window_start: NOW_S - 600,
    window_end: NOW_S,
    is_lightweight: true,
    code_active_count: 0,
    deep_work_duration_ms: 0,
    work_momentum_score: 0,
    work_app_duration_ms: 0,
    work_visit_count: 0,
    android_in_work_app: false,
    high_stimulus_visit_count: 0,
    entertainment_depth_score: 0,
    attention_fragmentation_score: 0,
    tab_explosion: false,
    android_unlock_rate: 0,
    android_fun_app_current: false,
    android_physical_activity: 'unknown',
    do_not_disturb: false,
    is_idle: false,
    event_counts: {},
    active_sources: [],
    ...partial,
  }
}

test('dissociating when fragmentation high and unlock rate high, no code activity', () => {
  // 碎片化（0.35）+ 高频解锁（0.55）= 0.9，单信号不足以判解离，需多信号叠加
  const snap = snapshot({ attention_fragmentation_score: 0.9, android_unlock_rate: 16, code_active_count: 0 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'dissociating')
})

test('working when code_active_count >= 3', () => {
  const snap = snapshot({ code_active_count: 4 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'working')
  // workScore 0.6 → confidence = 0.4 + 0.6 * 0.5 = 0.7
  assert.equal(result.confidence, 0.7)
})

test('working when deep_work_duration over 5 minutes with code activity', () => {
  // deep_work 单独仅贡献 0.15，需配合 code_active 计数越过 0.45 阈值
  const snap = snapshot({ deep_work_duration_ms: 6 * 60 * 1000, code_active_count: 3 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'working')
})

test('working when work app duration over 5 minutes with deep work', () => {
  // 非 VS Code 场景：Windows 工作进程（如 Office/IDE）持续使用 → working
  const snap = snapshot({ work_app_duration_ms: 6 * 60 * 1000, deep_work_duration_ms: 6 * 60 * 1000 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'working')
})

test('working when android work app in foreground with deep work', () => {
  const snap = snapshot({ android_in_work_app: true, deep_work_duration_ms: 3 * 60 * 1000, work_visit_count: 1 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'working')
})

test('recent work signal boosts workScore', () => {
  // 工作网站刚访问过（60s 内）→ recentWork +0.45，单信号即可判 working
  const snap = snapshot({ latest_work_signal_age_s: 10, work_visit_count: 2 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'working')
})

test('weak single work signal does not cross threshold', () => {
  // 仅工作网站访问一次（0.2 < 0.45），不足以判 working
  const snap = snapshot({ work_visit_count: 1 })
  const result = inferState(snap, { previousState: 'resting' })
  assert.notEqual(result.state, 'working')
})

test('entertaining when entertainment_depth over 0.5 with recent entertainment signal', () => {
  // depth 单独仅贡献 min(0.3, depth*0.3)，需近期娱乐信号（0.45）配合越过阈值
  const snap = snapshot({ entertainment_depth_score: 0.7, latest_entertainment_signal_age_s: 30 })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'entertaining')
})

test('resting when idle and physical activity not still', () => {
  const snap = snapshot({ is_idle: true, android_physical_activity: 'walking' })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'resting')
})

test('fallback keeps previous state when no rules fire and events exist', () => {
  // 有事件记录但不触发任何规则（如 window_focus 无其他信号），且非 idle
  // fallback 语义：证据不足时保持前一状态（迟滞），不重置为 transitioning
  const snap = snapshot({ event_counts: { window_focus: 1 } })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'working')
  assert.equal(result.confidence, 0.55)
})

test('resting when idle and physical activity is unknown (default)', () => {
  // android_physical_activity 默认值 'unknown' !== 'still'，应触发 resting
  const snap = snapshot({ is_idle: true })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'resting')
  assert.ok(result.confidence >= 0.85)
})

test('resting when event_counts is empty (30min 无事件静默信号)', () => {
  // 空事件：event_counts 为 {}，代表窗口内无任何活动
  const snap = snapshot({ event_counts: {} })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'resting')
})

test('state_changed reflects difference from previous', () => {
  const snap = snapshot({ code_active_count: 4 })
  const result = inferState(snap, { previousState: 'resting' })
  assert.equal(result.state_changed, true)
  assert.equal(result.previous_state, 'resting')
})

test('do_not_disturb passed through from snapshot', () => {
  const snap = snapshot({ code_active_count: 4, do_not_disturb: true })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.do_not_disturb, true)
})

test('memory injection boosts dissociating confidence in high-risk hour (mature onboarding)', () => {
  // prev 用 transitioning 绕过迟滞（迟滞设计：证据不足时保持前一状态，此测不覆盖该路径）
  const snap = snapshot({ android_unlock_rate: 16 })
  const result = inferState(snap, {
    previousState: 'transitioning',
    memory: { highRiskHours: [14, 15], onboardingDays: 30 },
    nowHour: 14,
  })
  assert.equal(result.state, 'dissociating')
  // 基础 confidence 0.725 + 高风险时段加成 0.1 = 0.825
  assert.ok(result.confidence > 0.8, `expected boosted, got ${result.confidence}`)
  assert.ok(result.evidence.includes('high_risk_hour'))
})

test('memory injection gives no boost during onboarding (< 4 days)', () => {
  const snap = snapshot({ android_unlock_rate: 16 })
  const result = inferState(snap, {
    previousState: 'working',
    memory: { highRiskHours: [14], onboardingDays: 2 },
    nowHour: 14,
  })
  assert.ok(result.confidence >= 0.55) // 无加成
})

test('memory injection no boost when hour not high-risk', () => {
  const snap = snapshot({ android_unlock_rate: 16 })
  const result = inferState(snap, {
    previousState: 'working',
    memory: { highRiskHours: [21, 22], onboardingDays: 30 },
    nowHour: 14,
  })
  assert.ok(result.confidence >= 0.55)
})

test('needs_ai_arbitration true when confidence is the fallback 0.55', () => {
  // 有事件但不触发任何规则：window_focus 无其他信号，非 idle，落到 fallback（保持前一状态）
  const snap = snapshot({ event_counts: { window_focus: 1 } })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'working')
  assert.equal(result.needs_ai_arbitration, true)
})

test('needs_ai_arbitration false for a clear single high-confidence state', () => {
  // code_active_count=5 且 event_counts 非空（不触发空事件 resting），仅 working 候选
  const snap = snapshot({ code_active_count: 5, event_counts: { code_active: 5 } })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.needs_ai_arbitration, false)
})

// ── 当下娱乐的决定性（打开娱乐软件即娱乐中）──────────────────

test('opening entertainment app while working → entertaining (decisive, no score competition)', () => {
  // 强工作证据（workScore 1.0）下打开高刺激 App：立即判娱乐中
  // 工作中打开娱乐软件 = 简单分心或开始娱乐，语义是娱乐而非解离
  const snap = snapshot({
    latest_entertainment_signal_age_s: 20,
    android_fun_app_current: true,
    latest_work_signal_age_s: 30,
    recent_code_active_count: 3,
    code_active_count: 8,
    work_app_duration_ms: 6 * 60 * 1000,
    work_momentum_score: 0.4,
    event_counts: { code_active: 8 },
  })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'entertaining')
})

test('high-stimulus url visit while working → entertaining immediately (hysteresis bypassed)', () => {
  const snap = snapshot({
    latest_entertainment_signal_age_s: 10,
    high_stimulus_visit_count: 1,
    latest_work_signal_age_s: 15,
    code_active_count: 5,
    event_counts: { code_active: 5, url_visit: 1 },
  })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'entertaining')
})

test('entertainment signal older than 60s → back to score competition (working wins)', () => {
  // 娱乐信号超龄：不再是「当下」，恢复分数竞争与迟滞
  const snap = snapshot({
    latest_entertainment_signal_age_s: 90,
    latest_work_signal_age_s: 20,
    recent_code_active_count: 2,
    code_active_count: 5,
    event_counts: { code_active: 5 },
  })
  const result = inferState(snap, { previousState: 'entertaining' })
  assert.equal(result.state, 'working')
})

// ── 窗口级工作信号压制解离风险 ────────────────────────────────

test('work site visits in window suppress dissociation (browser research is not dissociation)', () => {
  // 读工作文档/查资料：无 60s 内实时工作信号，但窗口内有工作网站访问
  // 碎片化 + 高频解锁不指向解离 → 证据不足，保持前一状态
  const snap = snapshot({
    android_unlock_rate: 16,
    attention_fragmentation_score: 0.9,
    work_visit_count: 2,
    latest_work_signal_age_s: 300,
    event_counts: { url_visit: 6, tab_switch: 9 },
  })
  const result = inferState(snap, { previousState: 'resting' })
  assert.equal(result.state, 'resting')
})

test('code activity earlier in window suppresses dissociation (工作中拿手机 ≠ 解离)', () => {
  // 窗口内写过代码（>60s 前）：随后刷手机/切窗口语义是娱乐分心摩擦，非病理解离
  const snap = snapshot({
    android_unlock_rate: 16,
    attention_fragmentation_score: 0.9,
    latest_work_signal_age_s: 90,
    code_active_count: 4,
    event_counts: { code_active: 4, window_focus: 9 },
  })
  const result = inferState(snap, { previousState: 'working' })
  assert.equal(result.state, 'working')
})

test('dissociating still fires when clearly no work signals in window', () => {
  // 无任何工作痕迹：risk 0.9（unlock 0.55 + frag 0.35）→ 解离
  const snap = snapshot({
    android_unlock_rate: 16,
    attention_fragmentation_score: 0.9,
    code_active_count: 0,
    event_counts: { window_focus: 9, screen_unlock: 16 },
  })
  const result = inferState(snap, { previousState: 'transitioning' })
  assert.equal(result.state, 'dissociating')
})
