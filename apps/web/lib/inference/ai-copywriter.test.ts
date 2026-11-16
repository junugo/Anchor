import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCopyPrompt, FALLBACK_MESSAGES, sanitizeMessage, generateCopy } from './ai-copywriter'

test('FALLBACK_MESSAGES covers all states', () => {
  for (const s of ['dissociating', 'entertaining', 'resting', 'working', 'transitioning'] as const) {
    assert.ok(FALLBACK_MESSAGES[s].length > 0)
  }
})

test('buildCopyPrompt embeds state, level, real time and constraints', () => {
  const prompt = buildCopyPrompt('entertaining', 'soft')
  assert.match(prompt, /entertaining|娱乐/)
  assert.match(prompt, /专注工作中|娱乐中|解离中|休息中|状态切换中/)
  assert.match(prompt, /当前真实时间/)
  assert.match(prompt, /禁止自行推测任何时刻/)
  assert.match(prompt, /80/)
})

test('sanitizeMessage trims and caps at 80 chars', () => {
  const long = '一'.repeat(120)
  const out = sanitizeMessage(long)
  assert.ok(out.length <= 80)
})

test('sanitizeMessage rejects forbidden phrases by falling back', () => {
  const out = sanitizeMessage('你应该马上停止', 'entertaining')
  // 含「你应该」→ 用 fallback
  assert.equal(out, FALLBACK_MESSAGES.entertaining)
})

test('sanitizeMessage returns trimmed valid message unchanged', () => {
  const out = sanitizeMessage('  歇会儿吧  ')
  assert.equal(out, '歇会儿吧')
})

// generateCopy 路径测试（mock fetch，不发真实网络请求）
test('generateCopy returns fallback when API key missing', async (_t) => {
  const saved = process.env['ANCHOR_AI_API_KEY']
  delete process.env['ANCHOR_AI_API_KEY']
  try {
    const out = await generateCopy('resting', 'soft')
    assert.equal(out, FALLBACK_MESSAGES.resting)
  } finally {
    if (saved !== undefined) process.env['ANCHOR_AI_API_KEY'] = saved
  }
})

test('generateCopy returns fallback on resp.ok=false', async () => {
  process.env['ANCHOR_AI_API_KEY'] = 'test-key'
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401 } as unknown as Response)
  try {
    const out = await generateCopy('entertaining', 'hard')
    assert.equal(out, FALLBACK_MESSAGES.entertaining)
  } finally {
    globalThis.fetch = origFetch
    delete process.env['ANCHOR_AI_API_KEY']
  }
})

test('generateCopy returns fallback on timeout (AbortError)', async () => {
  process.env['ANCHOR_AI_API_KEY'] = 'test-key'
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  try {
    const out = await generateCopy('dissociating', 'notify')
    assert.equal(out, FALLBACK_MESSAGES.dissociating)
  } finally {
    globalThis.fetch = origFetch
    delete process.env['ANCHOR_AI_API_KEY']
  }
})

test('generateCopy sanitizes and returns valid AI response', async () => {
  process.env['ANCHOR_AI_API_KEY'] = 'test-key'
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '  休息一会儿吧  ' } }] }),
  } as unknown as Response)
  try {
    const out = await generateCopy('working', 'soft')
    assert.equal(out, '休息一会儿吧')
  } finally {
    globalThis.fetch = origFetch
    delete process.env['ANCHOR_AI_API_KEY']
  }
})
