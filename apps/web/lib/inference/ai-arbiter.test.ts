import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeatureSnapshot, InferenceResult } from '@anchor/types'
import { buildArbiterPrompt, parseArbiterResponse, arbiterFallback } from './ai-arbiter'

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
function res(state: InferenceResult['state']): InferenceResult {
  return { state, confidence: 0.55, evidence: ['code_active_count=2'], previous_state: 'transitioning', state_changed: true, do_not_disturb: false, needs_ai_arbitration: true, snapshot: snap({ code_active_count: 2 }) }
}

test('buildArbiterPrompt includes evidence and candidate state', () => {
  const prompt = buildArbiterPrompt(res('working'))
  assert.match(prompt, /working/)
  assert.match(prompt, /code_active_count/)
  assert.match(prompt, /当前分析时段/)
})

test('parseArbiterResponse extracts state and confidence', () => {
  const parsed = parseArbiterResponse('{"state":"entertaining","confidence":0.82,"reasoning":"高刺激网页占主导"}')
  assert.equal(parsed?.state, 'entertaining')
  assert.equal(parsed?.confidence, 0.82)
})

test('parseArbiterResponse returns null on malformed json', () => {
  assert.equal(parseArbiterResponse('not json'), null)
})

test('parseArbiterResponse rejects invalid state value', () => {
  assert.equal(parseArbiterResponse('{"state":"sleeping","confidence":0.9}'), null)
})

test('arbiterFallback returns original rule result unchanged', () => {
  const original = res('working')
  const out = arbiterFallback(original)
  assert.equal(out.state, 'working')
  assert.equal(out.confidence, original.confidence)
})
