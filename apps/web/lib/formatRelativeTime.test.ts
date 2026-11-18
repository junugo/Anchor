import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRelativeTime } from './formatRelativeTime'

const NOW = 1_700_000_000

test('null → 从未活跃', () => {
  assert.equal(formatRelativeTime(null, NOW), '从未活跃')
})

test('小于 60 秒 → 刚刚', () => {
  assert.equal(formatRelativeTime(NOW - 0, NOW), '刚刚')
  assert.equal(formatRelativeTime(NOW - 59, NOW), '刚刚')
})

test('分钟级', () => {
  assert.equal(formatRelativeTime(NOW - 60, NOW), '1 分钟前')
  assert.equal(formatRelativeTime(NOW - 3 * 60, NOW), '3 分钟前')
  assert.equal(formatRelativeTime(NOW - 59 * 60, NOW), '59 分钟前')
})

test('小时级', () => {
  assert.equal(formatRelativeTime(NOW - 60 * 60, NOW), '1 小时前')
  assert.equal(formatRelativeTime(NOW - 5 * 3600, NOW), '5 小时前')
  assert.equal(formatRelativeTime(NOW - 23 * 3600, NOW), '23 小时前')
})

test('天级', () => {
  assert.equal(formatRelativeTime(NOW - 24 * 3600, NOW), '1 天前')
  assert.equal(formatRelativeTime(NOW - 30 * 24 * 3600, NOW), '30 天前')
})

test('未来时间兜底为 刚刚', () => {
  assert.equal(formatRelativeTime(NOW + 100, NOW), '刚刚')
})
