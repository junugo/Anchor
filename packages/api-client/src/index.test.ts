import { describe, it, expect, vi } from 'vitest'
import { createApiClient } from './index'

describe('createApiClient', () => {
  it('returns data on 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response)
    const result = await createApiClient('https://api.example.com').get('/users/1')
    expect(result.ok).toBe(true)
  })

  it('throws on 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
    } as Response)
    await expect(createApiClient('https://api.example.com').get('/x')).rejects.toMatchObject({ status: 404 })
  })
})
