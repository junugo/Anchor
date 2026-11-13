import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, interventionLogs } from '@anchor/db'
import type { InterventionPlan } from '@anchor/types'
import { recordDispatch } from '../inference/action-dispatcher'
import { recordInterventionResult } from '../ws/handlers'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-ivlog-'))
  return createDb(path.join(dir, 'anchor.db'))
}

function plan(partial: Partial<InterventionPlan>): InterventionPlan {
  return {
    id: 'iv-test-1',
    type: 'notify',
    targets: ['android'],
    action: 'android:push_notify',
    message: 'test',
    expires_at: 999999,
    ...partial,
  }
}

test('recordDispatch 落库干预事件（含 reason 与 state）', () => {
  const db = tempDb()
  try {
    recordDispatch(db, plan({ reason: '轻度娱乐', frictionFormId: 'chrome:long_press_3s' }), 'entertaining', 5000)
    const rows = db.select().from(interventionLogs).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].intervention_id, 'iv-test-1')
    assert.equal(rows[0].dispatched_at, 5000)
    assert.equal(rows[0].level, 'notify')
    assert.equal(rows[0].state, 'entertaining')
    assert.equal(rows[0].trigger_reason, '轻度娱乐')
    assert.equal(rows[0].friction_form_id, 'chrome:long_press_3s')
    assert.equal(rows[0].result, null)
  } finally { closeDb(db) }
})

test('回执按 intervention_id 回填 result，且不覆盖已有 result', () => {
  const db = tempDb()
  try {
    recordDispatch(db, plan({}), 'entertaining', 5000)
    recordInterventionResult(db, {
      intervention_id: 'iv-test-1',
      action: 'android:push_notify',
      result: 'dismissed',
      dismissed_by_user: true,
    }, 5060)
    // 重复回执不覆盖（保护首个结果）
    recordInterventionResult(db, {
      intervention_id: 'iv-test-1',
      action: 'android:push_notify',
      result: 'executed',
      dismissed_by_user: false,
    }, 5070)
    const rows = db.select().from(interventionLogs).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].result, 'dismissed')
    // 未知 intervention_id 的回执不产生新行
    recordInterventionResult(db, {
      intervention_id: 'iv-unknown',
      action: 'android:push_notify',
      result: 'executed',
      dismissed_by_user: false,
    }, 5080)
    assert.equal(db.select().from(interventionLogs).all().length, 1)
  } finally { closeDb(db) }
})
