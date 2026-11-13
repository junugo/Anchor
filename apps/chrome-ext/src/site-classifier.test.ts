import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSiteClassifier, type SiteClassificationsCache } from './site-classifier'

describe('createSiteClassifier', () => {
  let store: SiteClassificationsCache
  let storageGet: ReturnType<typeof vi.fn>
  let storageSet: ReturnType<typeof vi.fn>
  let classifyRequest: ReturnType<typeof vi.fn>
  let nowValue: number

  beforeEach(() => {
    store = {}
    nowValue = 1_700_000_000_000
    storageGet = vi.fn(async () => store)
    storageSet = vi.fn(async (_k: string, v: SiteClassificationsCache) => { store = v })
    classifyRequest = vi.fn(async () => ({ high_stimulus: true, source: 'ai' }))
  })

  function make() {
    return createSiteClassifier({
      storageGet,
      storageSet,
      classifyRequest,
      now: () => nowValue,
    })
  }

  it('unknown domain before any data', () => {
    const c = make()
    expect(c.status('example.com')).toBe('unknown')
  })

  it('subdomain matches cached high domain', async () => {
    const c = make()
    c.applyUpdate('bilibili.com', { high_stimulus: true, source: 'preset' })
    expect(c.isHigh('live.bilibili.com')).toBe(true)
    expect(c.isHigh('bilibilifake.com')).toBe(false)
  })

  it('low classification resolves to low', () => {
    const c = make()
    c.applyUpdate('github.com', { high_stimulus: false, source: 'ai' })
    expect(c.status('github.com')).toBe('low')
    expect(c.isHigh('github.com')).toBe(false)
  })

  it('highSet returns cache high domains', () => {
    const c = make()
    c.applyUpdate('youtube.com', { high_stimulus: true, source: 'ai' })
    c.applyUpdate('github.com', { high_stimulus: false, source: 'ai' })
    expect(c.highSet()).toEqual(['youtube.com'])
  })

  it('ensureClassified requests unknown domain and persists result', async () => {
    const c = make()
    c.ensureClassified('newsite.com')
    await vi.waitFor(() => expect(classifyRequest).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(c.status('newsite.com')).toBe('high'))
    expect(storageSet).toHaveBeenCalled()
  })

  it('ensureClassified does not request known domain', () => {
    const c = make()
    c.applyUpdate('known.com', { high_stimulus: false, source: 'ai' })
    c.ensureClassified('known.com')
    expect(classifyRequest).not.toHaveBeenCalled()
  })

  it('ensureClassified dedupes in-flight and cooldown', async () => {
    const c = make()
    c.ensureClassified('dup.com')
    c.ensureClassified('dup.com')
    await vi.waitFor(() => expect(classifyRequest).toHaveBeenCalledTimes(1))
    // 已完成并缓存，再次请求不再触发
    c.ensureClassified('dup.com')
    expect(classifyRequest).toHaveBeenCalledTimes(1)
  })

  it('applyDelete removes entry and resets cooldown', async () => {
    const c = make()
    c.applyUpdate('gone.com', { high_stimulus: true, source: 'ai' })
    expect(c.isHigh('gone.com')).toBe(true)
    c.applyDelete('gone.com')
    expect(c.status('gone.com')).toBe('unknown')
  })

  it('seedFromServer merges classifications and skips pending', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        classifications: [
          { domain: 'seeded.com', high_stimulus: true, classification_source: 'ai', updated_at: 100 },
          { domain: 'pending.com', high_stimulus: false, classification_source: 'pending', updated_at: 100 },
        ],
      }),
    })) as unknown as typeof fetch
    const c = make()
    await c.seedFromServer('http://localhost:4000')
    expect(c.isHigh('seeded.com')).toBe(true)
    expect(c.status('pending.com')).toBe('unknown')
  })

  it('syncFromServer replaces local cache and skips pending', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        classifications: [
          { domain: 'server.com', high_stimulus: true, classification_source: 'ai', updated_at: 100 },
          { domain: 'pending.com', high_stimulus: false, classification_source: 'pending', updated_at: 100 },
        ],
      }),
    })) as unknown as typeof fetch
    const c = make()
    c.applyUpdate('local-only.com', { high_stimulus: false, source: 'ai' })
    const res = await c.syncFromServer('http://localhost:4000')
    expect(res.ok).toBe(true)
    expect(c.isHigh('server.com')).toBe(true)
    expect(c.status('pending.com')).toBe('unknown')
    // 本地有而服务器没有的条目被清除
    expect(c.status('local-only.com')).toBe('unknown')
    expect(store['server.com']).toBeDefined()
    expect(store['local-only.com']).toBeUndefined()
  })

  it('syncFromServer returns false on failure and keeps local cache', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    const c = make()
    c.applyUpdate('keep.com', { high_stimulus: true, source: 'ai' })
    const res = await c.syncFromServer('http://localhost:4000')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('500')
    expect(c.isHigh('keep.com')).toBe(true)
  })

  it('syncFromServer reports network error', async () => {
    global.fetch = vi.fn(async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch
    const c = make()
    const res = await c.syncFromServer('http://localhost:4000')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Failed to fetch')
  })
})
