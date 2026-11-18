import assert from 'node:assert/strict'
import test from 'node:test'
import { createRateLimiter } from './rate-limit'

test('rate-limit：窗口内放行至上限，超限拒绝', () => {
  const rl = createRateLimiter()
  // limit=3：第 1~3 次放行，第 4 次拒绝
  assert.equal(rl.limit('login:1.2.3.4', 3, 60_000), true)
  assert.equal(rl.limit('login:1.2.3.4', 3, 60_000), true)
  assert.equal(rl.limit('login:1.2.3.4', 3, 60_000), true)
  assert.equal(rl.limit('login:1.2.3.4', 3, 60_000), false)
})

test('rate-limit：不同键互不影响', () => {
  const rl = createRateLimiter()
  rl.limit('login:a', 1, 60_000)
  assert.equal(rl.limit('login:b', 1, 60_000), true)
  assert.equal(rl.limit('login:a', 1, 60_000), false)
})

test('rate-limit：窗口过后重置', () => {
  let now = 1_000_000
  const originalNow = Date.now
  Date.now = () => now
  try {
    const rl = createRateLimiter()
    assert.equal(rl.limit('pair:ip', 1, 1000), true)
    assert.equal(rl.limit('pair:ip', 1, 1000), false)
    now += 1001 // 越过窗口
    assert.equal(rl.limit('pair:ip', 1, 1000), true)
  } finally {
    Date.now = originalNow
  }
})

test('rate-limit：reset 清空全部计数', () => {
  const rl = createRateLimiter()
  rl.limit('k', 1, 60_000)
  assert.equal(rl.limit('k', 1, 60_000), false)
  rl.reset()
  assert.equal(rl.limit('k', 1, 60_000), true)
})

test('rate-limit：键超过上限时整表清空（防键滞留）', () => {
  const rl = createRateLimiter()
  // 塞满 1000 个键后再来新键 → 触发清空，新键放行
  for (let i = 0; i < 1000; i++) assert.equal(rl.limit(`old:${i}`, 1, 60_000), true)
  assert.equal(rl.limit('login:a', 1, 60_000), true) // 触发 clear 后自身重建
  // 旧键已随清空重置
  assert.equal(rl.limit('old:0', 1, 60_000), true)
})
