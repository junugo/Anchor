import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { circadianLogs, closeDb, createDb } from '@anchor/db'
import type { DailyContext } from '@anchor/types'
import { archiveDailyContext, derivePeakHours } from './daily-archiver'

function ctx(p: Partial<DailyContext> = {}): DailyContext {
  return {
    date: '2026-06-17', deep_work_total_ms: 0, work_session_count: 0, longest_deep_work_ms: 0,
    dissociation_count: 0, dissociation_total_ms: 0, interventions_triggered: 0,
    interventions_dismissed: 0, interventions_effective: 0, android_unlock_count: 0,
    android_screen_on_total_ms: 0, work_by_hour: new Array(24).fill(0), distraction_by_hour: new Array(24).fill(0), ...p,
  }
}

test('derivePeakHours picks the busiest hour', () => {
  const wbh = new Array(24).fill(0); wbh[10] = 5; wbh[14] = 3
  const dbh = new Array(24).fill(0); dbh[22] = 4
  const { peakWork, peakDistraction } = derivePeakHours(wbh, dbh)
  assert.equal(peakWork, 10)
  assert.equal(peakDistraction, 22)
})

test('derivePeakHours returns null when all zero', () => {
  const { peakWork, peakDistraction } = derivePeakHours(new Array(24).fill(0), new Array(24).fill(0))
  assert.equal(peakWork, null)
  assert.equal(peakDistraction, null)
})

test('archiveDailyContext upserts a circadian_logs row with new fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-archive-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const wbh = new Array(24).fill(0); wbh[9] = 2
    const c = ctx({ deep_work_total_ms: 600_000, dissociation_count: 3, interventions_triggered: 4, interventions_dismissed: 1, android_unlock_count: 42, work_by_hour: wbh })
    archiveDailyContext(db, c)
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, '2026-06-17')).get()
    assert.equal(row?.deep_work_total_ms, 600_000)
    assert.equal(row?.dissociation_count, 3)
    assert.equal(row?.intervention_count, 4)
    assert.ok(Math.abs((row?.intervention_dismiss_rate ?? 0) - 0.25) < 1e-9)
    assert.equal(row?.android_unlock_count, 42)
    assert.equal(row?.peak_work_hour, 9)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('archiveDailyContext overwrites existing row on second call (upsert updates)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-upsert-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    // 第一次归档：初始数据
    archiveDailyContext(db, ctx({ deep_work_total_ms: 100_000, dissociation_count: 1 }))
    // 第二次归档：不同数据，应覆盖旧值
    const wbh = new Array(24).fill(0); wbh[14] = 3
    archiveDailyContext(db, ctx({ deep_work_total_ms: 900_000, dissociation_count: 5, android_unlock_count: 10, work_by_hour: wbh }))
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, '2026-06-17')).get()
    // 验证旧值已被新值覆盖（非新增行）
    assert.equal(row?.deep_work_total_ms, 900_000)
    assert.equal(row?.dissociation_count, 5)
    assert.equal(row?.android_unlock_count, 10)
    assert.equal(row?.peak_work_hour, 14)
    // 验证只有一行
    const allRows = db.select().from(circadianLogs).all()
    assert.equal(allRows.length, 1)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('archiveDailyContext sets intervention_dismiss_rate to 0 when no interventions triggered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-zero-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    archiveDailyContext(db, ctx({ interventions_triggered: 0, interventions_dismissed: 0 }))
    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, '2026-06-17')).get()
    assert.equal(row?.intervention_dismiss_rate, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
