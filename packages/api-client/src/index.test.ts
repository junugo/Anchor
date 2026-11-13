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

  it('returns error result on 404', async () => {
    // 契约：永不抛出，HTTP 错误以 Result 模式返回（见 createApiClient 注释）
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
    } as Response)
    const result = await createApiClient('https://api.example.com').get('/x')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(404)
      expect(result.message).toBe('Not Found')
    }
  })
})
