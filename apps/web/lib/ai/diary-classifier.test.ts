import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClassifyPrompt, parseClassification, DIARY_LABELS, buildEventsOrFallback, classifyDiaryEntry } from './diary-classifier'

test('DIARY_LABELS has three categories', () => {
  assert.deepEqual(DIARY_LABELS, ['active_rest', 'attention_break', 'dissociation'])
})

test('buildClassifyPrompt lists events and labels', () => {
  const prompt = buildClassifyPrompt([{ event_type: 'url_visit', domain: 'douyin.com', at: '22:10' }])
  assert.match(prompt, /douyin/)
  assert.match(prompt, /active_rest|attention_break|dissociation/)
})

test('parseClassification accepts a valid label', () => {
  assert.equal(parseClassification('attention_break'), 'attention_break')
  assert.equal(parseClassification('  dissociation  '), 'dissociation')
})

test('parseClassification rejects unknown label as null', () => {
  assert.equal(parseClassification('something_else'), null)
})

test('buildEventsOrFallback returns logs when non-empty', () => {
  const logs = [{ event_type: 'url_visit', domain: 'douyin.com', at: '22:10' }]
  const result = buildEventsOrFallback(logs, 'attention_break', '22:00')
  assert.deepEqual(result, logs)
})

test('buildEventsOrFallback falls back to candidate_label when logs empty', () => {
  const result = buildEventsOrFallback([], 'dissociation', '23:00')
  assert.equal(result.length, 1)
  assert.equal(result[0]!.event_type, 'dissociation')
  assert.equal(result[0]!.at, '23:00')
  assert.equal(result[0]!.domain, undefined)
})

test('classifyDiaryEntry returns null when no API key (entry stays pending)', async () => {
  const saved = process.env['ANCHOR_AI_API_KEY']
  delete process.env['ANCHOR_AI_API_KEY']
  try {
    const result = await classifyDiaryEntry([{ event_type: 'url_visit', domain: 'douyin.com', at: '22:10' }])
    assert.equal(result, null)
  } finally {
    if (saved !== undefined) process.env['ANCHOR_AI_API_KEY'] = saved
  }
})
