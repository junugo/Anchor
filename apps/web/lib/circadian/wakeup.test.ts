import assert from 'node:assert/strict'
import test from 'node:test'
import { createDb, closeDb, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { initSunsetConfig } from '../sunset/config'
import { userZonedTimeToUtc } from '../time/user-time'
import { recordSleepEnd, recordSleepEndAt, recordSleepStartAt } from './wakeup'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-wakeup-${name}-`))
  const db = createDb(path.join(dir, 'anchor.db'))
  initSunsetConfig(db)
  return { dir, db }
}

function row(db: Db, date: string) {
  return db.select().from(circadianLogs).where(eq(circadianLogs.date, date)).get()
}

// 2026-09-07 03:14（本地）入睡，06:00 起床的跨午夜场景
const SLEEP_START_S = userZonedTimeToUtc('2026-09-07', 3 * 60 + 14)
const WAKE_S = userZonedTimeToUtc('2026-09-07', 6 * 60)

test('recordSleepStartAt：迟来的探测值不得覆盖更早的真实入睡点', () => {
  const { dir, db } = tempDb('earliest-wins')
  try {
    recordSleepStartAt(db, SLEEP_START_S) // 03:14
    recordSleepStartAt(db, SLEEP_START_S + 3 * 3600) // 06:14 迟来 auto-confirm
    assert.equal(row(db, '2026-09-06')?.sleep_start, SLEEP_START_S, '03:14 属 12:00 分界的 9-06 睡眠日')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSleepStartAt：行内已有 end 且 start 更晚时拒绝写入（防 start>end 脏行）', () => {
  const { dir, db } = tempDb('start-after-end')
  try {
    // 先行写入 end = 06:00（行 9-06，按 sleep_start 归属）
    recordSleepEndAt(db, SLEEP_START_S, WAKE_S)
    assert.equal(row(db, '2026-09-06')?.sleep_end, WAKE_S)
    // 次日清晨 06:15 的迟来 start（9-09 的点击归 9-08 行的场景同型）：晚于 end → 拒绝
    recordSleepStartAt(db, WAKE_S + 15 * 60)
    const r = row(db, '2026-09-06')
    assert.equal(r?.sleep_start, null, '拒绝写入更晚的 sleep_start')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSleepEndAt：end 早于行内 start 时拒绝写入', () => {
  const { dir, db } = tempDb('end-before-start')
  try {
    recordSleepStartAt(db, SLEEP_START_S) // 03:14
    recordSleepEndAt(db, SLEEP_START_S - 3600, SLEEP_START_S - 1800) // start=02:14 归属行也已有更早 start
    const r = row(db, '2026-09-06')
    assert.equal(r?.sleep_end, null, 'end 不得早于已有 start')
    // 正常结算不受影响
    recordSleepEndAt(db, SLEEP_START_S, WAKE_S)
    assert.equal(row(db, '2026-09-06')?.sleep_end, WAKE_S)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSleepEnd：优先写入开放行（跨午夜睡眠不拆行）', () => {
  const { dir, db } = tempDb('open-row')
  try {
    recordSleepStartAt(db, SLEEP_START_S) // 9-06 行仅有 start
    // 9-07 日历日也已存在一行（白天 phantom 场景）
    db.insert(circadianLogs).values({ date: '2026-09-07', meals_count: 0, left_room_count: 0 }).run()

    const writtenDate = recordSleepEnd(db, WAKE_S)
    assert.equal(writtenDate, '2026-09-06', 'end 应写回 start 所在的开放行')
    assert.equal(row(db, '2026-09-06')?.sleep_end, WAKE_S)
    assert.equal(row(db, '2026-09-07')?.sleep_end, null, '日历日行不应被写入')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSleepEnd：无开放行时回退日历日；end 早于已有 start 时拒绝', () => {
  const { dir, db } = tempDb('fallback-row')
  try {
    // 场景 1：无开放行 → 日历日行
    const d1 = recordSleepEnd(db, WAKE_S)
    assert.equal(d1, '2026-09-07')
    assert.equal(row(db, '2026-09-07')?.sleep_end, WAKE_S)

    // 场景 2：行内已有更晚 start（脏数据残留）→ 拒绝，不制造负时长
    db.update(circadianLogs)
      .set({ sleep_start: WAKE_S + 3600 })
      .where(eq(circadianLogs.date, '2026-09-07'))
      .run()
    recordSleepEnd(db, WAKE_S + 1800)
    assert.equal(row(db, '2026-09-07')?.sleep_end, WAKE_S, '拒绝后 end 保持原值')
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
