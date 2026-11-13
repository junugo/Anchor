import { describe, expect, it } from 'vitest'
import { domainMatches, getDomain } from './utils'

describe('getDomain', () => {
  it('strips www prefix', () => {
    expect(getDomain('https://www.bilibili.com/video/BV123')).toBe('bilibili.com')
  })

  it('returns hostname as-is', () => {
    expect(getDomain('https://github.com/org/repo')).toBe('github.com')
  })

  it('returns empty string for invalid url', () => {
    expect(getDomain('not-a-url')).toBe('')
  })
})

describe('domainMatches', () => {
  it('exact match', () => {
    expect(domainMatches('bilibili.com', 'bilibili.com')).toBe(true)
  })

  it('subdomain match', () => {
    expect(domainMatches('live.bilibili.com', 'bilibili.com')).toBe(true)
  })

  it('does not match lookalike domains', () => {
    expect(domainMatches('bilibilifake.com', 'bilibili.com')).toBe(false)
  })

  it('does not match unrelated', () => {
    expect(domainMatches('github.com', 'bilibili.com')).toBe(false)
  })
})
