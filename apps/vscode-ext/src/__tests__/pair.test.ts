import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestPairing, normalizePairCode } from '../pair'

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizePairCode', () => {
  it('去空白并转大写', () => {
    expect(normalizePairCode('  ab3d-9f  ')).toBe('AB3D-9F')
    expect(normalizePairCode('x')).toBe('X')
  })
})

describe('requestPairing', () => {
  it('成功返回下发的凭证', async () => {
    mockFetchOnce(200, { token: 'tok', dataKey: 'dk', serverVersion: '1.2.3', deviceId: 7 })
    const result = await requestPairing('http://x:4000/', 'ab12', 'Dev', '0.0.1')
    expect(result).toEqual({ ok: true, token: 'tok', dataKey: 'dk', serverVersion: '1.2.3', deviceId: 7 })
    // 规范化 code + 去掉尾部斜杠
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledWith('http://x:4000/api/pair', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ code: 'AB12', deviceName: 'Dev', clientVersion: '0.0.1' }),
    }))
  })

  it('401 透出服务器文案', async () => {
    mockFetchOnce(401, { error: '配对码无效或已过期' })
    const result = await requestPairing('http://x', 'BAD', 'Dev', '0.0.1')
    expect(result).toEqual({ ok: false, error: '配对码无效或已过期' })
  })

  it('429/400/500 有兜底文案', async () => {
    mockFetchOnce(429, {})
    expect(await requestPairing('http://x', 'c', 'd', 'v')).toMatchObject({ ok: false })
    mockFetchOnce(400, {})
    expect(await requestPairing('http://x', 'c', 'd', 'v')).toMatchObject({ ok: false })
    mockFetchOnce(500, {})
    const r = await requestPairing('http://x', 'c', 'd', 'v')
    expect(r).toEqual({ ok: false, error: '配对失败（HTTP 500）' })
  })

  it('网络错误返回连接失败文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const result = await requestPairing('http://x', 'c', 'd', 'v')
    expect(result).toEqual({ ok: false, error: '无法连接服务器，请检查服务器地址' })
  })

  it('响应缺少凭证视为失败', async () => {
    mockFetchOnce(200, { token: 'tok' })
    const result = await requestPairing('http://x', 'c', 'd', 'v')
    expect(result).toEqual({ ok: false, error: '服务器响应缺少凭证，请稍后重试' })
  })
})
