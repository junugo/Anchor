import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { asc } from 'drizzle-orm'
import { behaviorLogs, closeDb, createDb, stateSegments } from '@anchor/db'
import { replayStateSegments, resetReplayGuard } from './replay'
import { initSunsetConfig } from '../sunset/config'
import { initSchoolSchedule } from '../school/schedule'
import { userZonedTimeToUtc } from '../time/user-time'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

const MON = '2026-09-07' // 周一
const SUN = '2026-09-06' // 周日

function allSegments(db: ReturnType<typeof createDb>) {
  return db.select().from(stateSegments).orderBy(asc(stateSegments.started_at)).all()
}

test('replay：上学日零事件白天 → away 段（而非「无数据」）', () => {
  const { dir, db } = tempDb('replay-away')
  resetReplayGuard()
  try {
    initSunsetConfig(db)
    initSchoolSchedule(db)
    const dayStart = userZonedTimeToUtc(MON, 0)
    replayStateSegments(db, dayStart, dayStart + 86400)

    const segs = allSegments(db)
    assert.equal(segs.length, 1)
    assert.equal(segs[0]!.state, 'away')
    assert.equal(segs[0]!.source, 'backfill')
    assert.equal(segs[0]!.started_at, userZonedTimeToUtc(MON, 420)) // 07:00 整点
    assert.equal(segs[0]!.ended_at, userZonedTimeToUtc(MON, 1020)) // 17:00（17 点中点 17:30 已到家，不在校）
  } finally {
    resetReplayGuard()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('replay：周末零事件白天 → 不留段（保持「无数据」）', () => {
  const { dir, db } = tempDb('replay-weekend')
  resetReplayGuard()
  try {
    initSunsetConfig(db)
    initSchoolSchedule(db)
    const dayStart = userZonedTimeToUtc(SUN, 0)
    const r = replayStateSegments(db, dayStart, dayStart + 86400)

    assert.equal(r.written, 0)
    assert.equal(allSegments(db).length, 0)
  } finally {
    resetReplayGuard()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('replay：睡眠哨兵优先于 away（校时段内的真实入睡不被日程覆盖）', () => {
  const { dir, db } = tempDb('replay-sentinel-priority')
  resetReplayGuard()
  try {
    initSunsetConfig(db)
    initSchoolSchedule(db)
    const dayStart = userZonedTimeToUtc(MON, 0)
    // 10 点小时的睡眠哨兵（判断引擎短路期间的权威状态）
    db.insert(behaviorLogs).values({
      source: 'web', event_type: 'state_inference', payload: {},
      inferred_state: 'sleeping', logged_at: userZonedTimeToUtc(MON, 610),
    }).run()

    replayStateSegments(db, dayStart, dayStart + 86400)

    const segs = allSegments(db)
    assert.deepEqual(
      segs.map(s => [s.state, s.started_at, s.ended_at]),
      [
        ['away', userZonedTimeToUtc(MON, 420), userZonedTimeToUtc(MON, 600)],
        ['sleeping', userZonedTimeToUtc(MON, 600), userZonedTimeToUtc(MON, 660)],
        ['away', userZonedTimeToUtc(MON, 660), userZonedTimeToUtc(MON, 1020)],
      ],
    )
  } finally {
    resetReplayGuard()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
