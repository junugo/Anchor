import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb } from '@anchor/db'
import { extractAssistantDeltaFromSseLine, getLastUserMessage, getRecentChatMessages, saveChatMessage } from './chatHistory'

function tempDbPath(name: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, dbPath: path.join(dir, 'anchor.db') }
}

test('saveChatMessage and getRecentChatMessages return oldest-to-newest history', () => {
  const { dir, dbPath } = tempDbPath('chat-history')
  const db = createDb(dbPath)
  try {
    saveChatMessage(db, 'user', 'first', 1)
    saveChatMessage(db, 'assistant', 'second', 2)
    saveChatMessage(db, 'user', 'third', 3)

    const rows = getRecentChatMessages(db, 2)
    assert.deepEqual(rows.map(row => row.content), ['second', 'third'])
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getLastUserMessage returns the last user message', () => {
  assert.equal(getLastUserMessage([
    { role: 'user', content: '旧消息' },
    { role: 'assistant', content: '回应' },
    { role: 'user', content: '新消息' },
  ]), '新消息')
})

test('extractAssistantDeltaFromSseLine parses DeepSeek delta content', () => {
  const line = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
  assert.equal(extractAssistantDeltaFromSseLine(line), '你好')
  assert.equal(extractAssistantDeltaFromSseLine('data: [DONE]'), '')
  assert.equal(extractAssistantDeltaFromSseLine(': keepalive'), '')
})
