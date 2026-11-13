import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserState } from '@anchor/types'
import { shouldTriggerImmediate } from './triggers'
import type { TriggerContext } from './triggers'

const HIGH_STIMULUS_APPS = ['com.ss.android.ugc.aweme', 'tv.danmaku.bili']
const WORK_PROCESSES = ['code.exe', 'idea64.exe', 'windowsterminal.exe']

function ctx(prevState: UserState): TriggerContext {
  return {
    prevState,
    isWorkProcess: (name) => WORK_PROCESSES.some(t => name.toLowerCase().includes(t)),
  }
}

// ── working / transitioning 侧：仅分心事件触发 ────────────────

test('working: high-stimulus app_foreground triggers', () => {
  assert.equal(shouldTriggerImmediate('app_foreground', { packageName: 'com.ss.android.ugc.aweme' }, HIGH_STIMULUS_APPS, ctx('working')), true)
})

test('working: non-high-stimulus app_foreground does not trigger', () => {
  assert.equal(shouldTriggerImmediate('app_foreground', { packageName: 'com.android.settings' }, HIGH_STIMULUS_APPS, ctx('working')), false)
})

test('working: high_stimulus url_visit triggers', () => {
  assert.equal(shouldTriggerImmediate('url_visit', { high_stimulus: true }, HIGH_STIMULUS_APPS, ctx('working')), true)
  assert.equal(shouldTriggerImmediate('url_visit', { high_stimulus: false }, HIGH_STIMULUS_APPS, ctx('working')), false)
})

test('working: video play triggers, pause does not', () => {
  assert.equal(shouldTriggerImmediate('video_state', { state: 'play' }, HIGH_STIMULUS_APPS, ctx('working')), true)
  assert.equal(shouldTriggerImmediate('video_state', { state: 'pause' }, HIGH_STIMULUS_APPS, ctx('working')), false)
})

test('working: tab_explosion triggers', () => {
  assert.equal(shouldTriggerImmediate('tab_explosion', {}, HIGH_STIMULUS_APPS, ctx('working')), true)
})

test('transitioning: distraction events also trigger', () => {
  assert.equal(shouldTriggerImmediate('app_foreground', { packageName: 'tv.danmaku.bili' }, HIGH_STIMULUS_APPS, ctx('transitioning')), true)
})

test('working: work-conformant events do NOT trigger (system stays silent)', () => {
  // 状态符合预期时系统沉默：code_active / 工作窗口不再是轻量管线触发源
  assert.equal(shouldTriggerImmediate('code_active', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('window_focus', { process: 'Code.exe' }, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('window_active', { process: 'Code.exe' }, HIGH_STIMULUS_APPS, ctx('working')), false)
})

test('working: screen_on / screen_unlock / mic / camera no longer trigger', () => {
  assert.equal(shouldTriggerImmediate('screen_on', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('screen_unlock', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('microphone_active', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('camera_active', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
})

// ── entertaining / dissociating 侧：工作事件快速纠错 ──────────

test('entertaining: code_active triggers (fast correction back to work)', () => {
  assert.equal(shouldTriggerImmediate('code_active', {}, HIGH_STIMULUS_APPS, ctx('entertaining')), true)
})

test('entertaining: work-process window_focus / window_active trigger', () => {
  assert.equal(shouldTriggerImmediate('window_focus', { process: 'idea64.exe', is_idle: false }, HIGH_STIMULUS_APPS, ctx('entertaining')), true)
  assert.equal(shouldTriggerImmediate('window_active', { process: 'Code.exe' }, HIGH_STIMULUS_APPS, ctx('entertaining')), true)
})

test('dissociating: non-work window_focus does not trigger', () => {
  assert.equal(shouldTriggerImmediate('window_focus', { process: 'QQMusic.exe', is_idle: false }, HIGH_STIMULUS_APPS, ctx('dissociating')), false)
})

test('dissociating: idle window_focus does not trigger', () => {
  assert.equal(shouldTriggerImmediate('window_focus', { process: 'Code.exe', is_idle: true }, HIGH_STIMULUS_APPS, ctx('dissociating')), false)
})

test('entertaining: distraction events do NOT trigger (already in that state)', () => {
  assert.equal(shouldTriggerImmediate('app_foreground', { packageName: 'com.ss.android.ugc.aweme' }, HIGH_STIMULUS_APPS, ctx('entertaining')), false)
  assert.equal(shouldTriggerImmediate('url_visit', { high_stimulus: true }, HIGH_STIMULUS_APPS, ctx('entertaining')), false)
})

// ── resting 侧：不触发（宵禁由 full tick + sunset 状态机管理）──

test('resting: nothing triggers', () => {
  assert.equal(shouldTriggerImmediate('app_foreground', { packageName: 'com.ss.android.ugc.aweme' }, HIGH_STIMULUS_APPS, ctx('resting')), false)
  assert.equal(shouldTriggerImmediate('code_active', {}, HIGH_STIMULUS_APPS, ctx('resting')), false)
  assert.equal(shouldTriggerImmediate('screen_unlock', {}, HIGH_STIMULUS_APPS, ctx('resting')), false)
})

test('non-listed event does not trigger regardless of state', () => {
  assert.equal(shouldTriggerImmediate('physical_activity', {}, HIGH_STIMULUS_APPS, ctx('working')), false)
  assert.equal(shouldTriggerImmediate('user_idle', {}, HIGH_STIMULUS_APPS, ctx('entertaining')), false)
})

import { debounceImmediateTrigger, resetTriggerDebounce } from './triggers'

test('debounce blocks rapid re-triggers within 500ms', () => {
  resetTriggerDebounce()
  assert.equal(debounceImmediateTrigger(1_000_000), true)
  assert.equal(debounceImmediateTrigger(1_000_200), false) // 200ms 后被防抖
})

test('debounce blocks pipeline within 5s cooldown', () => {
  resetTriggerDebounce()
  assert.equal(debounceImmediateTrigger(2_000_000), true)
  // 1 秒后，过了 500ms 防抖但未过 5s pipeline 冷却
  assert.equal(debounceImmediateTrigger(2_001_000), false)
  // 6 秒后两个窗口都过了
  assert.equal(debounceImmediateTrigger(2_006_000), true)
})
