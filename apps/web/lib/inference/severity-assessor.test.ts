import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { circadianLogs, closeDb, createDb, userLivingContext, userMemory } from '@anchor/db'

import { computeSeverityLevel } from './severity-assessor'

// 辅助：创建隔离测试数据库
function makeTmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-severity-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  return { db, dir }
}

// 辅助：向 user_living_context 插入 default 用户行
function seedContext(db: ReturnType<typeof createDb>, overrides: Record<string, unknown> = {}) {
  db.insert(userLivingContext)
    .values({
      user_id: 'default',
      inferred_state: 'resting',
      location_zone: 'unknown',
      screen_active: false,
      focuslayer_sync_enabled: false,
      updated_at: Math.floor(Date.now() / 1000),
      ...overrides,
    })
    .onConflictDoUpdate({
      target: userLivingContext.user_id,
      set: { updated_at: Math.floor(Date.now() / 1000), ...overrides },
    })
    .run()
}

// 辅助：向 circadian_logs 插入一行，date 相对今天偏移 daysAgo
function seedCircadian(db: ReturnType<typeof createDb>, daysAgo: number, overrides: Record<string, unknown> = {}) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const dateStr = d.toISOString().slice(0, 10)
  db.insert(circadianLogs)
    .values({
      date: dateStr,
      meals_count: 3,
      left_room_count: 2,
      ...overrides,
    } as typeof circadianLogs.$inferInsert)
    .onConflictDoUpdate({
      target: circadianLogs.date,
      set: overrides as Partial<typeof circadianLogs.$inferInsert>,
    })
    .run()
}

// 辅助：写入 userMemory 键
function seedMemory(db: ReturnType<typeof createDb>, key: typeof userMemory.$inferInsert['key'], value: Record<string, unknown>, updatedAt: number) {
  db.insert(userMemory)
    .values({ key, value: JSON.stringify(value), updated_at: updatedAt })
    .onConflictDoUpdate({
      target: userMemory.key,
      set: { value: JSON.stringify(value), updated_at: updatedAt },
    })
    .run()
}

// ── L3：极端条件下评估为 critical ─────────────────────────────────────────────
test('L3 — extreme conditions → critical', () => {
  const { db, dir } = makeTmpDb()
  try {
    seedContext(db)
    const nowMs = Date.now()
    const nowS = Math.floor(nowMs / 1000)

    // 连续 3 天睡眠极端偏移（>90min = >5400s，即凌晨约 3:30 才睡）
    // 设 sleep_start = 日期凌晨 00:00 + 4h（14400s）→ 偏移 4h > 90min
    for (let i = 0; i < 3; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      const dayStartS = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000)
      seedCircadian(db, i, {
        sleep_start: dayStartS + 4 * 3600, // 04:00 入睡，偏移 4h
        dissociation_count: 5,
        dissociation_total_ms: 5 * 60 * 60 * 1000, // 5h/天
      })
    }

    // 自填评分 1（最差），在 24h 内
    seedMemory(db, 'self_report', { score: 1 }, nowS - 3600)
    // AI 情绪信号：distress，在 24h 内
    seedMemory(db, 'emotional_signal', { signal: 'distress' }, nowS - 1800)

    const result = computeSeverityLevel(db, nowMs)
    assert.equal(result, 'L3', `期望 L3，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── L0：平静条件下评估为 L0（正常）─────────────────────────────────────────
test('L0 — calm conditions → null (normal)', () => {
  const { db, dir } = makeTmpDb()
  try {
    seedContext(db)
    const nowMs = Date.now()
    const nowS = Math.floor(nowMs / 1000)

    // 连续 3 天睡眠正常（偏移 < 30min = 1800s，即凌晨 00:30 前睡）
    for (let i = 0; i < 3; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      const dayStartS = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000)
      seedCircadian(db, i, {
        sleep_start: dayStartS + 0.25 * 3600, // 00:15 入睡，偏移 15min
        dissociation_count: 0,
        dissociation_total_ms: 0,
      })
    }

    // 自填评分 5（最好），在 24h 内
    seedMemory(db, 'self_report', { score: 5 }, nowS - 3600)
    // AI 情绪信号：stable，在 24h 内
    seedMemory(db, 'emotional_signal', { signal: 'stable' }, nowS - 1800)

    const result = computeSeverityLevel(db, nowMs)
    assert.equal(result, 'L0', `期望 L0（正常），实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 中等信号：睡眠偏移 + 娱乐超时 → medium 或 high ──────────────────────────
test('moderate signals → medium or high', () => {
  const { db, dir } = makeTmpDb()
  try {
    seedContext(db)
    const nowMs = Date.now()

    // 今天睡眠偏移 > 90min（passiveScore += 2）
    const d = new Date()
    const dateStr = d.toISOString().slice(0, 10)
    const dayStartS = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000)
    seedCircadian(db, 0, {
      sleep_start: dayStartS + 2 * 3600, // 02:00，偏移 2h
      dissociation_total_ms: 4.5 * 60 * 60 * 1000, // 4.5h，超过 L2 阈值（passiveScore += 2）
      dissociation_count: 1,
    })

    // 无记忆信号（过期或无）
    const result = computeSeverityLevel(db, nowMs)
    assert.ok(result === 'L1' || result === 'L2' || result === 'L3', `期望 L1 或 L2 或 L3，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 24h 迟滞守卫：新等级低于当前等级但未满 24h，维持当前 ──────────────────────
test('hysteresis guard — does not downgrade within 24h', () => {
  const { db, dir } = makeTmpDb()
  try {
    const nowMs = Date.now()
    const nowS = Math.floor(nowMs / 1000)
    // severity_changed_at = 1h 前：在当前等级上仅稳定 1h，不允许下降
    // （计时基准是 severity_changed_at，不是每 tick 刷新的 updated_at）
    seedContext(db, {
      severity_level: 'L2',
      severity_changed_at: nowS - 3600,
      updated_at: nowS, // 模拟 full tick 刚刷新过 updated_at
    })

    // 数据平静（评分为 null）
    const result = computeSeverityLevel(db, nowMs)
    // 守卫应维持当前 L2 等级
    assert.equal(result, 'L2', `期望迟滞守卫保持 L2，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 迟滞守卫：已稳定 >24h 允许下降 ──────────────────────────────────────────
test('hysteresis guard — allows downgrade after 24h', () => {
  const { db, dir } = makeTmpDb()
  try {
    const nowMs = Date.now()
    const nowS = Math.floor(nowMs / 1000)
    // severity_changed_at = 25h 前：已稳定满 24h
    seedContext(db, {
      severity_level: 'L1',
      severity_changed_at: nowS - 25 * 3600,
      updated_at: nowS,
    })

    // 数据平静（所有信号正常），评分应为 null
    const result = computeSeverityLevel(db, nowMs)
    // 守卫已满 24h，应允许下降到 L0
    assert.equal(result, 'L0', `期望守卫允许降至 L0，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 历史行 severity_changed_at 为 NULL：视为已久远，允许下降（自愈旧库卡住的等级）──
test('hysteresis guard — NULL severity_changed_at allows downgrade (legacy row self-heal)', () => {
  const { db, dir } = makeTmpDb()
  try {
    const nowMs = Date.now()
    seedContext(db, { severity_level: 'L2' }) // severity_changed_at 未播种 → NULL

    const result = computeSeverityLevel(db, nowMs)
    assert.equal(result, 'L0', `NULL severity_changed_at 应允许下降，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 过期信号不参与计分 ─────────────────────────────────────────────────────
test('stale self_report (>24h old) is ignored', () => {
  const { db, dir } = makeTmpDb()
  try {
    seedContext(db)
    const nowMs = Date.now()
    const nowS = Math.floor(nowMs / 1000)

    // 自填评分 1（最差），但 updated_at 超过 24h
    seedMemory(db, 'self_report', { score: 1 }, nowS - 25 * 3600)
    // AI 情绪信号也过期
    seedMemory(db, 'emotional_signal', { signal: 'distress' }, nowS - 26 * 3600)

    // 无 circadian 数据（passive score = 0）
    const result = computeSeverityLevel(db, nowMs)
    assert.equal(result, 'L0', `过期信号应被忽略，实际: ${result}`)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
