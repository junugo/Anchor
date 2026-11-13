import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createDb, closeDb } from '@anchor/db'
import { buildMemorySection, buildAnchorRoleCard, CRISIS_KEYWORDS } from './roleCard'
import { tempDbPath } from '../testUtils'

test('buildMemorySection omits empty memory rows', () => {
  assert.equal(buildMemorySection([{ key: 'sleep_pattern', value: '', updated_at: 0 }]), '')
})

test('buildMemorySection renders known memory keys with Chinese labels', () => {
  const section = buildMemorySection([
    { key: 'sleep_pattern', value: '通常凌晨 1 点后入睡。', updated_at: 1 },
    { key: 'response_to_intervention', value: '对轻柔提醒反应更好。', updated_at: 1 },
  ])

  assert.match(section, /\[用户观察\]/)
  assert.match(section, /睡眠规律：通常凌晨 1 点后入睡。/)
  assert.match(section, /干预响应：对轻柔提醒反应更好。/)
})

test('buildAnchorRoleCard includes severity section for L3 with system trigger', () => {
  const { dir, dbPath } = tempDbPath('rolecard-l3')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db, 'L3', 'system')
    assert.match(card, /\[当前状态\] L3/)
    assert.match(card, /我在。/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildAnchorRoleCard includes severity section for L1 without system trigger', () => {
  const { dir, dbPath } = tempDbPath('rolecard-l1')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db, 'L1', 'user')
    assert.match(card, /\[当前状态\] L1/)
    assert.doesNotMatch(card, /\[主动触发\]/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildAnchorRoleCard includes system trigger section when trigger=system', () => {
  const { dir, dbPath } = tempDbPath('rolecard-sys')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db, 'L2', 'system')
    assert.match(card, /\[主动触发\]/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildAnchorRoleCard omits crisis section at L0', () => {
  const { dir, dbPath } = tempDbPath('rolecard-crisis-l0')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db, 'L0', 'user')
    assert.doesNotMatch(card, /\[危机边界\]/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildAnchorRoleCard includes crisis section at L1+', () => {
  const { dir, dbPath } = tempDbPath('rolecard-crisis-l1')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db, 'L1', 'user')
    assert.match(card, /\[危机边界\]/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CRISIS_KEYWORDS includes expected keywords', () => {
  assert.ok(CRISIS_KEYWORDS.includes('不想活'))
  assert.ok(CRISIS_KEYWORDS.includes('想死'))
})

test('buildAnchorRoleCard defaults to L0 user trigger', () => {
  const { dir, dbPath } = tempDbPath('rolecard-defaults')
  const db = createDb(dbPath)
  try {
    const card = buildAnchorRoleCard(db)
    assert.match(card, /\[当前状态\] L0/)
    assert.doesNotMatch(card, /\[主动触发\]/)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
