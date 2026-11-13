import { describe, it, expect } from 'vitest'
import { formatDate } from '../date'
import { isNonEmpty } from '../string'
import { invariant } from '../assert'

describe('utils', () => {
  it('formatDate returns a string', () => {
    expect(typeof formatDate(new Date('2024-01-01'))).toBe('string')
  })
  it('isNonEmpty', () => {
    expect(isNonEmpty('hello')).toBe(true)
    expect(isNonEmpty('')).toBe(false)
    expect(isNonEmpty(null)).toBe(false)
  })
  it('invariant throws on falsy', () => {
    expect(() => invariant(false, 'fail')).toThrow('fail')
    expect(() => invariant(true, 'ok')).not.toThrow()
  })
})
