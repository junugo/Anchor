import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApiClient } from '../index'

beforeEach(() => { vi.restoreAllMocks() })

describe('createApiClient', () => {
  it('returns data on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: '1' }) })
    const client = createApiClient('http://api.test')
    const result = await client.get('/user')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ id: '1' })
  })
  it('returns ApiError on http error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    const client = createApiClient('http://api.test')
    const result = await client.get('/missing')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(404)
  })
})
