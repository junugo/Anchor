import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, behaviorLogs, stateSegments } from '@anchor/db'
import { replayStateSegments, resetReplayGuard } from './replay'

const H = 3600
// 小时对齐基准（本地时区任意整点）
const H0 = Math.floor(new Date('2026-08-01T10:00:00').getTime() / 1000 / H) * H

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-replay-'))
  return createDb(path.join(dir, 'anchor.db'))
}

function rt(db: ReturnType<typeof tempDb>, start: number, end: number | null) {
  db.insert(stateSegments).values({ state: 'working', started_at: start, ended_at: end, source: 'realtime' }).run()
}

function codeActiveLogs(db: ReturnType<typeof tempDb>, fromS: number, count: number) {
  for (let i = 0; i < count; i++) {
    db.insert(behaviorLogs).values({
      source: 'vscode', event_type: 'code_active', payload: {}, logged_at: fromS + i * 60,
    }).run()
  }
}

test('realtime 段之前的空档被回填，realtime 段原样不动', () => {
  const db = tempDb()
  resetReplayGuard()
  try {
    codeActiveLogs(db, H0 + 600, 3) // H0 小时内有工作信号
    rt(db, H0 + 2 * H, null) // 服务器 H2 才上线
    const r = replayStateSegments(db, H0, H0 + 4 * H)
    assert.ok(r.written >= 1)
    const rows = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    const backfill = rows.filter(x => x.source === 'backfill')
    const realtime = rows.filter(x => x.source === 'realtime')
    assert.equal(backfill[0].state, 'working')
    assert.equal(backfill[0].started_at, H0)
    // backfill 不越过 realtime 边界
    for (const b of backfill) assert.ok((b.ended_at ?? 0) <= H0 + 2 * H)
    // realtime 原样：仍 open、未被改写
    assert.equal(realtime.length, 1)
    assert.equal(realtime[0].started_at, H0 + 2 * H)
    assert.equal(realtime[0].ended_at, null)
  } finally { closeDb(db) }
})

test('幂等：重复运行不产生重复段', () => {
  const db = tempDb()
  resetReplayGuard()
  try {
    codeActiveLogs(db, H0 + 600, 3)
    const r1 = replayStateSegments(db, H0, H0 + 3 * H)
    const r2 = replayStateSegments(db, H0, H0 + 3 * H)
    assert.equal(r1.written, r2.written)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, r1.written)
  } finally { closeDb(db) }
})

test('零事件小时不留段', () => {
  const db = tempDb()
  resetReplayGuard()
  try {
    const r = replayStateSegments(db, H0, H0 + 5 * H)
    assert.equal(r.written, 0)
    assert.equal(db.select().from(stateSegments).all().length, 0)
  } finally { closeDb(db) }
})

test('含睡眠哨兵日志的小时判 sleeping', () => {
  const db = tempDb()
  resetReplayGuard()
  try {
    db.insert(behaviorLogs).values({
      source: 'web', event_type: 'state_inference',
      payload: { state: 'sleeping', reason: 'sunset_session_sleeping' },
      inferred_state: 'sleeping', logged_at: H0 + 120,
    }).run()
    const r = replayStateSegments(db, H0, H0 + 2 * H)
    assert.equal(r.written, 1)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows[0].state, 'sleeping')
    assert.equal(rows[0].source, 'backfill')
  } finally { closeDb(db) }
})
