import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { chatMessages, circadianLogs, closeDb, contextSwitchDumps, createDb, dailyIntentions, frictionEvents, userLivingContext, userMemory } from '@anchor/db'
import { tempDbPath } from './testUtils'

test('createDb creates chat history and fixed user memory rows', () => {
  const { dir, dbPath } = tempDbPath('schema')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)

    db.insert(chatMessages).values({ role: 'user', content: '今晚有点散', created_at: 1 }).run()
    const message = db.select().from(chatMessages).get()
    assert.equal(message?.role, 'user')
    assert.equal(message?.content, '今晚有点散')

    const rows = db.select().from(userMemory).all()
    assert.deepEqual(rows.map(row => row.key).sort(), [
      'dissociation_pattern',
      'emotional_signal',
      'mood_trend',
      'response_to_intervention',
      'sleep_pattern',
    ])
    assert.deepEqual(rows.map(row => row.updated_at), [0, 0, 0, 0, 0])
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('circadian sunset_compliance stores minute delta as a number', () => {
  const { dir, dbPath } = tempDbPath('sunset-compliance')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    db.insert(circadianLogs).values({
      date: '2026-06-11',
      meals_count: 0,
      left_room_count: 0,
      sunset_compliance: 15,
    }).run()

    const row = db.select().from(circadianLogs).where(eq(circadianLogs.date, '2026-06-11')).get()
    assert.equal(row?.sunset_compliance, 15)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('user_living_context severity_level column stores and retrieves values', () => {
  const { dir, dbPath } = tempDbPath('severity-level')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Date.now()
    db.insert(userLivingContext).values({
      user_id: 'default',
      inferred_state: 'dissociating',
      location_zone: 'sofa',
      screen_active: true,
      updated_at: now,
      severity_level: 'L2',
    }).run()

    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row?.severity_level, 'L2')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('daily_intentions table stores and retrieves daily intention records', () => {
  const { dir, dbPath } = tempDbPath('daily-intentions')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Date.now()
    db.insert(dailyIntentions).values({
      date: '2026-06-22',
      content: '今天专注完成行为分析引擎',
      source: 'bedtime',
      created_at: now,
    }).run()

    const row = db.select().from(dailyIntentions).where(eq(dailyIntentions.date, '2026-06-22')).get()
    assert.equal(row?.content, '今天专注完成行为分析引擎')
    assert.equal(row?.source, 'bedtime')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('context_switch_dumps table stores and retrieves dump records', () => {
  const { dir, dbPath } = tempDbPath('context-switch-dumps')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const nowS = Math.floor(Date.now() / 1000)
    db.insert(contextSwitchDumps).values({
      dumped_at: nowS,
      source: 'user_text',
      content: '停在了 auth.ts 的 JWT 验证逻辑',
      inferred_payload: { inferred_file: 'src/auth.ts' },
      created_at: nowS,
    }).run()

    const rows = db.select().from(contextSwitchDumps).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.source, 'user_text')
    assert.equal(rows[0]?.content, '停在了 auth.ts 的 JWT 验证逻辑')
    assert.deepEqual(rows[0]?.inferred_payload, { inferred_file: 'src/auth.ts' })
    assert.equal(rows[0]?.focuslayer_issue_id, null)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('friction_events table stores triggered and bypassed events', () => {
  const { dir, dbPath } = tempDbPath('friction-events')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const nowS = Math.floor(Date.now() / 1000)
    db.insert(frictionEvents).values({
      form_id: 'curfew:countdown_10s',
      event_type: 'triggered',
      context: { action: 'chrome:friction_banner' },
      recorded_at: nowS,
    }).run()
    db.insert(frictionEvents).values({
      form_id: 'curfew:countdown_10s',
      event_type: 'bypassed',
      context: {},
      recorded_at: nowS + 5,
    }).run()

    const rows = db.select().from(frictionEvents).where(eq(frictionEvents.form_id, 'curfew:countdown_10s')).all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.event_type, 'triggered')
    assert.equal(rows[1]?.event_type, 'bypassed')
    assert.deepEqual(rows[0]?.context, { action: 'chrome:friction_banner' })
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
