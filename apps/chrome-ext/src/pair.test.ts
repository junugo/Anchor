import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadServerConfig, PAIR_INVALID_KEY } from './config'
import { normalizePairCode, requestPairing } from './pair'
import { installChromeMock, type ChromeMock } from './testing/chrome-mock'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('pair', () => {
  let chromeMock: ChromeMock

  beforeEach(() => {
    chromeMock = installChromeMock()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizePairCode：去空白 + 大写', () => {
    expect(normalizePairCode('  a3f9-2k7d ')).toBe('A3F9-2K7D')
  })

  it('成功：写 storage（token/dataKey 覆盖）并返回服务器版本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      token: 'tok-new',
      dataKey: 'key-new',
      serverVersion: '2.0.0',
      deviceId: 7,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await requestPairing('http://localhost:4000/', ' a3f9 ', 'Chrome · Windows', '0.0.1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toBe('tok-new')
      expect(result.dataKey).toBe('key-new')
      expect(result.serverVersion).toBe('2.0.0')
      expect(result.deviceId).toBe(7)
    }

    // 请求体：code 规范化、含 deviceName 与 clientVersion
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:4000/api/pair')
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'A3F9',
      deviceName: 'Chrome · Windows',
      clientVersion: '0.0.1',
    })

    // storage 写入 + config 缓存刷新 + 清除 pairInvalid
    expect(chromeMock.storage.local._map.get('anchor:token')).toBe('tok-new')
    expect(chromeMock.storage.local._map.get('anchor:dataKey')).toBe('key-new')
    expect(chromeMock.storage.local._map.get('anchor:deviceName')).toBe('Chrome · Windows')
    expect(chromeMock.storage.local._map.get('anchor:serverUrl')).toBe('http://localhost:4000')
    expect(chromeMock.storage.local._map.get(PAIR_INVALID_KEY)).toBe(false)
    expect(chromeMock.storage.local._map.get('anchor:pairedAt') as number).toBeGreaterThanOrEqual(before)

    const cfg = await loadServerConfig()
    expect(cfg.token).toBe('tok-new')
    expect(cfg.dataKey).toBe('key-new')
  })

  it('失败 401：透出配对码无效文案，不写 storage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: '配对码无效或已过期' })))
    const result = await requestPairing('http://localhost:4000', 'XXXX', 'dev', '0.0.1')
    expect(result).toEqual({ ok: false, error: '配对码无效或已过期' })
    expect(chromeMock.storage.local._map.get('anchor:token')).toBeUndefined()
  })

  it('失败 429：透出限频文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: '请求过于频繁' })))
    const result = await requestPairing('http://localhost:4000', 'XXXX', 'dev', '0.0.1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('频繁')
  })

  it('失败 400：透出参数错文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'deviceName 不能为空' })))
    const result = await requestPairing('http://localhost:4000', 'XXXX', '', '0.0.1')
    expect(result).toEqual({ ok: false, error: 'deviceName 不能为空' })
  })

  it('网络异常：返回无法连接文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await requestPairing('http://localhost:4000', 'XXXX', 'dev', '0.0.1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('无法连接服务器')
  })
})
