import { describe, it, expect } from 'vitest'
import { isNonEmpty, invariant, formatDate, STATE_LABELS, STATE_COLOR_TOKENS } from './index'

describe('isNonEmpty', () => {
  it('true for non-empty', () => expect(isNonEmpty('hello')).toBe(true))
  it('false for empty', () => expect(isNonEmpty('')).toBe(false))
  it('false for null', () => expect(isNonEmpty(null)).toBe(false))
})

describe('invariant', () => {
  it('throws when false', () => expect(() => invariant(false, 'oops')).toThrow('oops'))
  it('no throw when true', () => expect(() => invariant(true, 'x')).not.toThrow())
})

describe('formatDate', () => {
  it('returns string', () => {
    const d = new Date(2026, 0, 1)
    expect(typeof formatDate(d)).toBe('string')
  })
})

describe('STATE_LABELS', () => {
  it('covers all states', () => {
    expect(Object.keys(STATE_LABELS).sort()).toEqual(
      ['working', 'entertaining', 'dissociating', 'resting', 'sleeping', 'transitioning', 'away'].sort()
    )
  })
})

describe('STATE_COLOR_TOKENS', () => {
  it('follows AGENTS.md intervention levels', () => {
    expect(STATE_COLOR_TOKENS.working).toBe('passive')
    expect(STATE_COLOR_TOKENS.resting).toBe('soft')
    expect(STATE_COLOR_TOKENS.entertaining).toBe('hard')
    expect(STATE_COLOR_TOKENS.dissociating).toBe('curfew')
    expect(STATE_COLOR_TOKENS.sleeping).toBe('sleep')
    expect(STATE_COLOR_TOKENS.transitioning).toBeNull()
  })
})
