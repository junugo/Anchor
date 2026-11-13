import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { closeDb, createDb, aiConversationSummaries, userMemory } from '@anchor/db'
import { saveChatMessage } from './chatHistory'
import { generateConversationSummary } from './summary'
import { tempDbPath } from '../testUtils'

test('generateConversationSummary writes a DeepSeek summary for a message range', async () => {
  const { dir, dbPath } = tempDbPath('summary')
  const originalFetch = globalThis.fetch
  const originalKey = process.env['DEEPSEEK_API_KEY']
  const db = createDb(dbPath)

  try {
    saveChatMessage(db, 'user', '今晚很散，停不下来刷手机', 10)
    saveChatMessage(db, 'assistant', '先看看身体有没有累。', 20)
    saveChatMessage(db, 'user', '有点麻木，也有点饿', 30)

    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '用户夜间出现刷手机停不下来的状态，表达麻木和饥饿。' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    const result = await generateConversationSummary(db, { start: 1, end: 40 })
    const rows = db.select().from(aiConversationSummaries).all()

    assert.equal(result, '用户夜间出现刷手机停不下来的状态，表达麻木和饥饿。')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.summary, result)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey == null) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = originalKey
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generateConversationSummary writes emotional_signal to userMemory', async () => {
  const { dir, dbPath } = tempDbPath('summary-signal')
  const originalFetch = globalThis.fetch
  const originalKey = process.env['DEEPSEEK_API_KEY']
  const db = createDb(dbPath)

  try {
    saveChatMessage(db, 'user', '今天很累，心里难受，感觉很焦虑', 10)
    saveChatMessage(db, 'assistant', '听起来你现在压力很大，先喝点水。', 20)
    saveChatMessage(db, 'user', '嗯，就是很烦', 30)

    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '用户情绪低落，表达疲惫和焦虑。' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    await generateConversationSummary(db, { start: 1, end: 40 })

    const memRows = db.select().from(userMemory).all()
    const signalRow = memRows.find(r => r.key === 'emotional_signal')

    assert.ok(signalRow, 'emotional_signal row should exist in userMemory')
    const parsed = JSON.parse(signalRow!.value) as { signal: string; recordedAt: number }
    assert.ok(['distress', 'withdrawal', 'stable'].includes(parsed.signal))
    assert.ok(typeof parsed.recordedAt === 'number')
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey == null) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = originalKey
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
