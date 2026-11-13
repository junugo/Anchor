import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, createDb, userMemory, circadianLogs } from '@anchor/db'
import { coldStartPhase, injectionScale, loadMemory, getOnboardingDays } from './memory-loader'

// ── 纯函数测试（不需 DB）──────────────────────────────────────────

test('coldStartPhase 按 onboardingDays 分段', () => {
  assert.equal(coldStartPhase(0), 'recording')
  assert.equal(coldStartPhase(2), 'recording')
  assert.equal(coldStartPhase(3), 'transition')
  assert.equal(coldStartPhase(13), 'transition')
  assert.equal(coldStartPhase(14), 'full')
  assert.equal(coldStartPhase(100), 'full')
})

test('injectionScale 按阶段返回 0 / 0.5 / 1', () => {
  assert.equal(injectionScale(0), 0)
  assert.equal(injectionScale(5), 0.5)
  assert.equal(injectionScale(30), 1)
})

// ── DB 集成测试 ───────────────────────────────────────────────────

test('loadMemory 在 recording 阶段（<3天）返回 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-loader-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    // 不插入任何 circadian_logs 行 → onboardingDays = 0
    const result = loadMemory(db)
    assert.equal(result, undefined)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadMemory 在 transition 阶段（3-13天）返回 InferenceMemory（injectionScale = 0.5）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-loader-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    // 插入 5 行 circadian_logs → onboardingDays = 5，属于 transition 阶段
    for (let i = 0; i < 5; i++) {
      db.insert(circadianLogs).values({ date: `2026-06-0${i + 1}` }).run()
    }
    // transition 阶段 injectionScale = 0.5 ≠ 0，应返回 InferenceMemory（非 undefined）
    const mem = loadMemory(db)
    assert.ok(mem !== undefined, 'transition 阶段应返回 InferenceMemory，不得被冷启动拦截')
    assert.equal(mem!.onboardingDays, 5)
    // 默认 KV 为空字符串，解析后使用 fallback：highRiskHours = []
    assert.deepEqual(mem!.highRiskHours, [])
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadMemory 在 full 阶段（>=14天）返回扁平 InferenceMemory（含 sleep_pattern）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-loader-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    // 插入 14 行 circadian_logs → onboardingDays = 14
    for (let i = 0; i < 14; i++) {
      const d = new Date(2026, 5, 1 + i)
      db.insert(circadianLogs).values({ date: d.toISOString().slice(0, 10) }).run()
    }

    // 写入 user_memory KV（createDb 已预填充行，使用 update 更新）
    db.update(userMemory)
      .set({ value: JSON.stringify({ high_risk_hours: [22, 23] }), updated_at: 0 })
      .where(eq(userMemory.key, 'dissociation_pattern'))
      .run()
    db.update(userMemory)
      .set({ value: JSON.stringify({ high_dismissal: true, avg_dismiss_rate: 0.8 }), updated_at: 0 })
      .where(eq(userMemory.key, 'response_to_intervention'))
      .run()
    db.update(userMemory)
      .set({ value: JSON.stringify({ dissociation_rising: true }), updated_at: 0 })
      .where(eq(userMemory.key, 'mood_trend'))
      .run()
    db.update(userMemory)
      .set({ value: JSON.stringify({ typical_sleep_minutes: 420 }), updated_at: 0 })
      .where(eq(userMemory.key, 'sleep_pattern'))
      .run()

    const mem = loadMemory(db)
    assert.ok(mem !== undefined, '应返回 InferenceMemory')
    assert.deepEqual(mem!.highRiskHours, [22, 23])
    assert.equal(mem!.highDismissal, true)
    assert.ok((mem!.avgDismissRate ?? 0) > 0.7)
    assert.equal(mem!.dissociationRising, true)
    assert.equal(mem!.onboardingDays, 14)
    // 验证 sleep_pattern 解析路径（typical_sleep_minutes 字段映射）
    assert.equal(mem!.typicalSleepMinutes, 420)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getOnboardingDays 返回 circadian_logs 行数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-loader-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    assert.equal(getOnboardingDays(db), 0)
    db.insert(circadianLogs).values({ date: '2026-06-01' }).run()
    db.insert(circadianLogs).values({ date: '2026-06-02' }).run()
    assert.equal(getOnboardingDays(db), 2)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
