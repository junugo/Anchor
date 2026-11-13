import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, createDb, userMemory } from '@anchor/db'
import { parseMemoryResponse, shouldUpdateUserMemory, updateUserMemory } from './memory'
import { saveChatMessage } from './chatHistory'

function tempDbPath(name: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, dbPath: path.join(dir, 'anchor.db') }
}

test('parseMemoryResponse accepts fenced JSON and keeps fixed keys', () => {
  const parsed = parseMemoryResponse('```json\n{"sleep_pattern":"凌晨入睡","dissociation_pattern":"切换应用后加重","mood_trend":"偏疲惫","response_to_intervention":"适合轻提醒"}\n```')
  assert.equal(parsed.sleep_pattern, '凌晨入睡')
  assert.equal(parsed.response_to_intervention, '适合轻提醒')
})

test('shouldUpdateUserMemory respects six-hour cooldown', () => {
  // All 4 keys present — cooldown is the only deciding factor
  const allFourRows = [{ updated_at: 100 }, { updated_at: 100 }, { updated_at: 100 }, { updated_at: 100 }]
  assert.equal(shouldUpdateUserMemory(allFourRows, 100 + 6 * 60 * 60 - 1), false)
  assert.equal(shouldUpdateUserMemory(allFourRows, 100 + 6 * 60 * 60), true)
})

test('shouldUpdateUserMemory returns true when fewer than 4 keys present', () => {
  // 2 rows present, both recent — still needs update because keys are missing
  assert.equal(shouldUpdateUserMemory([{ updated_at: 100 }, { updated_at: 200 }], 201), true)
})

test('updateUserMemory writes extracted memory rows', async () => {
  const { dir, dbPath } = tempDbPath('memory')
  const originalFetch = globalThis.fetch
  const originalKey = process.env['DEEPSEEK_API_KEY']
  const db = createDb(dbPath)

  try {
    saveChatMessage(db, 'user', '我最近总是凌晨才睡', 10)
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        sleep_pattern: '最近倾向凌晨后入睡。',
        dissociation_pattern: '疲惫时更容易刷手机。',
        mood_trend: '近期状态偏疲惫。',
        response_to_intervention: '对轻柔身体感受提问反应较好。',
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    const updated = await updateUserMemory(db, { force: true, now: 1000 })
    const sleep = db.select().from(userMemory).where(eq(userMemory.key, 'sleep_pattern')).get()

    assert.equal(updated, true)
    assert.equal(sleep?.value, '最近倾向凌晨后入睡。')
    assert.equal(sleep?.updated_at, 1000)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey == null) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = originalKey
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
