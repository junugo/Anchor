import assert from 'node:assert/strict'
import test from 'node:test'
import { chatCompletionsUrl, maskApiKey, normalizeBaseUrl, resolveAiConfig } from './provider'

const ENV_KEYS = ['ANCHOR_AI_API_KEY', 'ANCHOR_AI_BASE_URL', 'ANCHOR_AI_MODEL'] as const

function clearEnv() {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('normalizeBaseUrl strips trailing slashes and /chat/completions suffix', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1//'), 'https://api.deepseek.com/v1')
  assert.equal(
    normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1'
  )
  assert.equal(
    normalizeBaseUrl('http://localhost:11434/v1/chat/completions/'),
    'http://localhost:11434/v1'
  )
})

test('resolveAiConfig returns null when ANCHOR_AI_API_KEY missing', () => {
  const restore = clearEnv()
  try {
    assert.equal(resolveAiConfig(), null)
  } finally {
    restore()
  }
})

test('resolveAiConfig defaults to DeepSeek endpoint and deepseek-chat model', () => {
  const restore = clearEnv()
  try {
    process.env['ANCHOR_AI_API_KEY'] = 'sk-test-key'
    const cfg = resolveAiConfig()
    assert.ok(cfg)
    assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal(cfg.model, 'deepseek-chat')
    assert.equal(cfg.apiKey, 'sk-test-key')
  } finally {
    restore()
  }
})

test('resolveAiConfig honors explicit base url and model', () => {
  const restore = clearEnv()
  try {
    process.env['ANCHOR_AI_API_KEY'] = 'sk-test-key'
    process.env['ANCHOR_AI_BASE_URL'] = 'http://localhost:11434/v1/'
    process.env['ANCHOR_AI_MODEL'] = 'qwen3:8b'
    const cfg = resolveAiConfig()
    assert.ok(cfg)
    assert.equal(cfg.baseUrl, 'http://localhost:11434/v1')
    assert.equal(cfg.model, 'qwen3:8b')
  } finally {
    restore()
  }
})

test('resolveAiConfig treats blank key as unconfigured', () => {
  const restore = clearEnv()
  try {
    process.env['ANCHOR_AI_API_KEY'] = '   '
    assert.equal(resolveAiConfig(), null)
  } finally {
    restore()
  }
})

test('chatCompletionsUrl appends suffix to normalized base', () => {
  const cfg = { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' }
  assert.equal(chatCompletionsUrl(cfg), 'https://api.openai.com/v1/chat/completions')
})

test('maskApiKey masks middle of key', () => {
  assert.equal(maskApiKey('sk-abcdefghij1234'), 'sk-…1234')
  assert.equal(maskApiKey('ab'), '…ab')
})
