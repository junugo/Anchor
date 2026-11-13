import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, interventionLogs, stateSegments } from '@anchor/db'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { db: createDb(path.join(dir, 'anchor.db')), dir }
}

test('state_segments 表可插入并查询', () => {
  const { db } = tempDb('tl-schema-seg')
  try {
    db.insert(stateSegments).values({ state: 'working', started_at: 1000, ended_at: null, source: 'realtime' }).run()
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'working')
    assert.equal(rows[0].ended_at, null)
    assert.equal(rows[0].source, 'realtime')
  } finally {
    closeDb(db)
  }
})

test('intervention_logs 表可插入并查询', () => {
  const { db } = tempDb('tl-schema-iv')
  try {
    db.insert(interventionLogs).values({
      intervention_id: 'iv-1',
      dispatched_at: 2000,
      action: 'android:push_notify',
      level: 'notify',
      state: 'entertaining',
      trigger_reason: '轻度娱乐',
      friction_form_id: null,
      result: null,
    }).run()
    const rows = db.select().from(interventionLogs).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].level, 'notify')
    assert.equal(rows[0].result, null)
  } finally {
    closeDb(db)
  }
})
