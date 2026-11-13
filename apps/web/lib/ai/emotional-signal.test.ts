import assert from 'node:assert/strict'
import test from 'node:test'
import { extractEmotionalSignal } from './emotional-signal'

test('detects distress from keywords', () => {
  const signal = extractEmotionalSignal('最近真的很累，什么都不想做，感觉很焦虑')
  assert.equal(signal.signal, 'distress')
})

test('detects withdrawal from silence pattern', () => {
  const signal = extractEmotionalSignal('嗯。不知道。就这样吧。')
  assert.equal(signal.signal, 'withdrawal')
})

test('defaults to stable', () => {
  const signal = extractEmotionalSignal('今天还不错，出门散了步')
  assert.equal(signal.signal, 'stable')
})

test('returns confidence and evidence fields', () => {
  const signal = extractEmotionalSignal('感觉很累')
  assert.ok(typeof signal.confidence === 'number')
  assert.ok(typeof signal.evidence === 'string')
})

test('detects distress from two matching keywords', () => {
  const signal = extractEmotionalSignal('最近真的很崩溃，受不了了')
  assert.equal(signal.signal, 'distress')
})

test('single keyword alone does not trigger distress (falls to stable)', () => {
  // DISTRESS_KEYWORDS 需要 >= 2 匹配才触发 distress；单个关键词应降级为 stable
  const signal = extractEmotionalSignal('最近真的很累，不过还好吧')
  assert.equal(signal.signal, 'stable')
})

test('stable text has high confidence', () => {
  const signal = extractEmotionalSignal('今天完成了很多工作，感觉不错')
  assert.equal(signal.signal, 'stable')
  assert.ok(signal.confidence > 0.5)
})
