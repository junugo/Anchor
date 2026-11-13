import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb, closeDb, behaviorLogs, decisionCooldowns } from '@anchor/db'
import type { Db } from '@anchor/db'
import { runDecision, getSunsetPhase } from './engine'
import { initSunsetConfig } from '../sunset/config'
import { reportSleepStart, getTodaySession } from '../sleep/engine'

const enabled = { phase_t60_enabled: true, phase_t30_enabled: true, phase_t15_enabled: true, phase_t0_enabled: true }

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-engine-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

function seedLog(db: Db, eventType: string, loggedAt: number, payload: Record<string, unknown> = {}) {
  db.insert(behaviorLogs).values({
    source: 'android',
    event_type: eventType,
    payload,
    logged_at: loggedAt,
  }).run()
}

// 决策引擎各干预块的冷却键（sleeping 分流下不应写入任何一条）
const DECISION_COOLDOWN_KEYS = [
  'after_break',
  'attention_residue',
  'dissociation',
  'focuslayer_query',
  'entertainment_alert',
  'conversation_summary',
  'check_in',
  'life_rescue',
]

test('getSunsetPhase returns T60 and T30 before target bedtime', () => {
  assert.equal(getSunsetPhase(60, 90, enabled), 'T30')
  assert.equal(getSunsetPhase(45, 90, enabled), 'T60')
})

test('getSunsetPhase returns T15 within 15 minutes of bedtime', () => {
  assert.equal(getSunsetPhase(80, 90, enabled), 'T15')
  assert.equal(getSunsetPhase(75, 90, enabled), 'T15')
})

test('getSunsetPhase falls back to T30 when T15 is disabled', () => {
  const noT15 = { ...enabled, phase_t15_enabled: false }
  assert.equal(getSunsetPhase(80, 90, noT15), 'T30')
})

test('getSunsetPhase returns null in T15 window when both T15 and T30 are disabled', () => {
  const neither = { ...enabled, phase_t15_enabled: false, phase_t30_enabled: false }
  assert.equal(getSunsetPhase(80, 90, neither), null)
})

test('getSunsetPhase returns T0 at and after target bedtime', () => {
  assert.equal(getSunsetPhase(90, 90, enabled), 'T0')
  assert.equal(getSunsetPhase(120, 90, enabled), 'T0')
})

test('getSunsetPhase does not fire before the one-hour window', () => {
  assert.equal(getSunsetPhase(23 * 60, 90, enabled), null)
})

test('runDecision sleeping 分流：只推进睡眠状态机，不产出任何决策干预', async () => {
  const { dir, db } = tempDb('sleeping-shortcut')
  try {
    initSunsetConfig(db)
    const nowS = Math.floor(Date.now() / 1000)
    // 1 小时前点「睡了」→ sleeping 会话（未满 8h，走活跃检测路径）
    reportSleepStart(db, nowS - 3600)
    // 点睡后出现强活动（刷手机）→ 睡眠引擎应转 wake_observing（2026-10 观察窗机制）
    seedLog(db, 'screen_unlock', nowS - 300)
    // 预置最近相位为 T0：sleeping/wake_observing 恒为 T0，跳过广播/睡前提醒副作用，聚焦分流本身
    ;(globalThis as unknown as { __anchorSunsetLastPhase?: string | null }).__anchorSunsetLastPhase = 'T0'

    await runDecision(db, 'sleeping', null)

    // a) 睡眠状态机正常推进：sleeping + 强活跃 → wake_observing，相位流转未因短路被跳过
    // 与种子同用 nowS - 3600（而非真实 now）：避免 12:00–13:00 时种子落在前一会话日而读错行
    const s = getTodaySession(db, nowS - 3600)
    assert.equal(s.phase, 'wake_observing')
    assert.equal(s.wake_first_activity_at != null, true)
    assert.equal(s.wake_observe_until_at != null, true)
    // b) 无任何干预动作：决策引擎各干预块的冷却键均未写入
    const rows = db.select({ key: decisionCooldowns.key }).from(decisionCooldowns).all()
    const written = new Set(rows.map(r => r.key))
    for (const key of DECISION_COOLDOWN_KEYS) {
      assert.equal(written.has(key), false, `sleeping 分流不应写入决策冷却键 ${key}`)
    }
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
