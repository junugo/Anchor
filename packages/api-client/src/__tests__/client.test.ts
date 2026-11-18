import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApiClient, AuthError } from '../index'
import { createAnchorApiClient } from '../anchor-api'

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

describe('认证支持', () => {
  it('传入 token 时注入 Authorization: Bearer 头', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    const client = createApiClient('http://api.test', { token: 'dev-token' })
    await client.get('/user')
    expect(global.fetch).toHaveBeenCalledWith(
      'http://api.test/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer dev-token' }),
      }),
    )
  })

  it('未传 token 时不注入 Authorization 头', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    const client = createApiClient('http://api.test')
    await client.get('/user')
    const headers = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers
    expect(headers.Authorization).toBeUndefined()
  })

  it('响应 401 时抛出 AuthError（携带状态信息）', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })
    const client = createApiClient('http://api.test', { token: 'bad-token' })
    const err = await client.get('/user').catch(e => e)
    expect(err).toBeInstanceOf(AuthError)
    expect(err.status).toBe(401)
    expect(err.statusText).toBe('Unauthorized')
  })
})

describe('createAnchorApiClient 配对与版本', () => {
  it('pair：POST /api/pair，body 携带 code/deviceName/clientVersion', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 't1', dataKey: 'k1', serverVersion: '2.0.0', deviceId: 'd1' }),
    })
    const client = createAnchorApiClient('http://api.test')
    const result = await client.pair('123456', '测试设备', '1.0.0')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.token).toBe('t1')
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api.test/api/pair')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ code: '123456', deviceName: '测试设备', clientVersion: '1.0.0' })
  })

  it('getVersion：GET /api/version', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '2.0.0' }) })
    const client = createAnchorApiClient('http://api.test')
    const result = await client.getVersion()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.version).toBe('2.0.0')
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api.test/api/version')
    expect(init.method).toBeUndefined()
  })

  it('token 选项透传到 Anchor 客户端', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '2.0.0' }) })
    const client = createAnchorApiClient('http://api.test', { token: 'tok' })
    await client.getVersion()
    const headers = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer tok')
  })
})
