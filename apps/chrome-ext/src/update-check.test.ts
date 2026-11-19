import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseLatestVersion, parseVersion, shouldCheck, CHECK_INTERVAL_MS } from './update-check'

describe('parseVersion', () => {
  it('解析纯版本与 v 前缀', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2')).toEqual([1, 2, 0])
    expect(parseVersion('1')).toEqual([1, 0, 0])
  })

  it('去掉端前缀（desktop-/mobile-/chrome-/vscode-）', () => {
    expect(parseVersion('desktop-v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('mobile-v2.0.0')).toEqual([2, 0, 0])
    expect(parseVersion('chrome-v0.3.1')).toEqual([0, 3, 1])
    expect(parseVersion('vscode-v1.0.0')).toEqual([1, 0, 0])
  })

  it('pre-release 后缀只取核心版本', () => {
    expect(parseVersion('v1.2.3-beta')).toEqual([1, 2, 3])
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
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('desktop-v1.0.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('mobile-v1.3.0', '1.2.9')).toBe(true)
  })

  it('同级或更旧返回 false', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false)
    expect(isNewerVersion('abc', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', 'abc')).toBe(false)
  })
})

describe('parseLatestVersion', () => {
  it('取 tag_name', () => {
    expect(parseLatestVersion({ tag_name: 'desktop-v1.2.3' })).toBe('desktop-v1.2.3')
    expect(parseLatestVersion({})).toBeNull()
    expect(parseLatestVersion(null)).toBeNull()
  })
})

describe('shouldCheck', () => {
  it('6 小时节流', () => {
    const now = 10 * CHECK_INTERVAL_MS
    expect(shouldCheck(now, 0)).toBe(true)
    expect(shouldCheck(now, now - CHECK_INTERVAL_MS)).toBe(true)
    expect(shouldCheck(now, now - CHECK_INTERVAL_MS + 1)).toBe(false)
    expect(shouldCheck(now, now)).toBe(false)
  })
})
