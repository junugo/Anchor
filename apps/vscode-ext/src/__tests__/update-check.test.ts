import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  alreadyNotifiedToday,
  fetchLatestVersion,
  isNewerVersion,
  parseLatestVersion,
  parseVersion,
  todayString,
} from '../update-check'

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

describe('parseVersion', () => {
  it('解析纯版本、v 前缀与端前缀', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('desktop-v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('mobile-v2.0.0')).toEqual([2, 0, 0])
    expect(parseVersion('1.2')).toEqual([1, 2, 0])
    expect(parseVersion('1.2.3-beta')).toEqual([1, 2, 3])
  })

  it('非法输入返回 null', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('a.b.c')).toBeNull()
    expect(parseVersion('1.2.3.4')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('语义比较', () => {
    expect(isNewerVersion('1.2.3', '1.2.2')).toBe(true)
    expect(isNewerVersion('desktop-v1.0.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
  })

  it('同级或更旧返回 false', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false)
    expect(isNewerVersion('abc', '1.0.0')).toBe(false)
  })
})

describe('parseLatestVersion', () => {
  it('取 tag_name', () => {
    expect(parseLatestVersion({ tag_name: 'mobile-v1.2.3' })).toBe('mobile-v1.2.3')
    expect(parseLatestVersion({})).toBeNull()
  })
})

describe('alreadyNotifiedToday / todayString', () => {
  it('同日已提示', () => {
    expect(alreadyNotifiedToday('2026-11-19', '2026-11-19')).toBe(true)
    expect(alreadyNotifiedToday('2026-11-19', '2026-11-18')).toBe(false)
    expect(alreadyNotifiedToday('2026-11-19', undefined)).toBe(false)
  })

  it('todayString 格式 yyyy-mm-dd', () => {
    expect(todayString(new Date(2026, 10, 19))).toBe('2026-11-19')
    expect(todayString(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('fetchLatestVersion', () => {
  it('成功返回 tag', async () => {
    mockFetchOnce(200, { tag_name: 'desktop-v1.2.3' })
    expect(await fetchLatestVersion()).toBe('desktop-v1.2.3')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.github.com/repos/junugo/Anchor/releases/latest')
  })

  it('非 2xx / 异常返回 null（静默）', async () => {
    mockFetchOnce(403, {})
    expect(await fetchLatestVersion()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchLatestVersion()).toBeNull()
  })
})
