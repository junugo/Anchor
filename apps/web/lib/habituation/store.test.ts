import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createDb, closeDb } from '@anchor/db'
import { tempDbPath } from '../testUtils'
import { recordFrictionEvent, isHabituated, bypassSpeedMs } from './store'

test('isHabituated returns true after 5 fast bypasses', () => {
  const { dir, dbPath } = tempDbPath('habituation-fast')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 5; i++) {
      recordFrictionEvent(db, { formId: 'f1', eventType: 'triggered', recordedAt: now - (5 - i) * 20 })
      recordFrictionEvent(db, { formId: 'f1', eventType: 'bypassed', recordedAt: now - (5 - i) * 20 + 5 })
    }
    assert.equal(isHabituated(db, 'f1'), true)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isHabituated returns false when fewer than 5 pairs', () => {
  const { dir, dbPath } = tempDbPath('habituation-few')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 3; i++) {
      recordFrictionEvent(db, { formId: 'f2', eventType: 'triggered', recordedAt: now - (3 - i) * 20 })
      recordFrictionEvent(db, { formId: 'f2', eventType: 'bypassed', recordedAt: now - (3 - i) * 20 + 5 })
    }
    assert.equal(isHabituated(db, 'f2'), false)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isHabituated returns false when bypasses are slow', () => {
  const { dir, dbPath } = tempDbPath('habituation-slow')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 5; i++) {
      recordFrictionEvent(db, { formId: 'f3', eventType: 'triggered', recordedAt: now - (5 - i) * 60 })
      // 绕过时间 > 10s，不算习惯化
      recordFrictionEvent(db, { formId: 'f3', eventType: 'bypassed', recordedAt: now - (5 - i) * 60 + 15 })
    }
    assert.equal(isHabituated(db, 'f3'), false)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bypassSpeedMs returns Infinity when no events', () => {
  const { dir, dbPath } = tempDbPath('habituation-empty')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const speed = bypassSpeedMs(db, 'unknown_form')
    assert.equal(speed, Infinity)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isHabituated returns true when recent bypasses are 70%+ faster than first bypass', () => {
  const { dir, dbPath } = tempDbPath('habituation-relative')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    // 第一次绕过：100 秒（基准）
    recordFrictionEvent(db, { formId: 'f5', eventType: 'triggered', recordedAt: now - 700 })
    recordFrictionEvent(db, { formId: 'f5', eventType: 'bypassed', recordedAt: now - 700 + 100 })
    // 随后 5 次绕过：28 秒（比首次快 72%，超过 70% 阈值；但 >10s 不触发绝对阈值）
    for (let i = 0; i < 5; i++) {
      recordFrictionEvent(db, { formId: 'f5', eventType: 'triggered', recordedAt: now - (5 - i) * 60 })
      recordFrictionEvent(db, { formId: 'f5', eventType: 'bypassed', recordedAt: now - (5 - i) * 60 + 28 })
    }
    assert.equal(isHabituated(db, 'f5'), true, '28s < 30% of 100s => 相对习惯化')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isHabituated returns false when recent bypasses are only 50% faster than first bypass', () => {
  const { dir, dbPath } = tempDbPath('habituation-relative-no')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    // 第一次绕过：100 秒
    recordFrictionEvent(db, { formId: 'f6', eventType: 'triggered', recordedAt: now - 700 })
    recordFrictionEvent(db, { formId: 'f6', eventType: 'bypassed', recordedAt: now - 700 + 100 })
    // 随后 5 次绕过：50 秒（快了 50%，未超 70% 阈值；也 >10s 不触发绝对阈值）
    for (let i = 0; i < 5; i++) {
      recordFrictionEvent(db, { formId: 'f6', eventType: 'triggered', recordedAt: now - (5 - i) * 60 })
      recordFrictionEvent(db, { formId: 'f6', eventType: 'bypassed', recordedAt: now - (5 - i) * 60 + 50 })
    }
    assert.equal(isHabituated(db, 'f6'), false, '50s > 30% of 100s => 未达相对习惯化')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bypassSpeedMs returns average bypass time in ms', () => {
  const { dir, dbPath } = tempDbPath('habituation-speed')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    // 5 pairs: each bypassed 6 seconds after triggered
    for (let i = 0; i < 5; i++) {
      recordFrictionEvent(db, { formId: 'f4', eventType: 'triggered', recordedAt: now - (5 - i) * 30 })
      recordFrictionEvent(db, { formId: 'f4', eventType: 'bypassed', recordedAt: now - (5 - i) * 30 + 6 })
    }
    const speed = bypassSpeedMs(db, 'f4')
    assert.equal(speed, 6000)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
