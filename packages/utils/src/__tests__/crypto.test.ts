import { describe, expect, it } from 'vitest'
import {
  decryptJson,
  encryptEnvelope,
  encryptJson,
  generateDataKey,
  resolveDataKey,
  unwrapBody,
} from '../crypto'

const TEST_KEY = 'anchor-dev-data-key'

describe('crypto（AES-256-GCM 上行加密）', () => {
  it('roundtrip：加密后能解出原值', async () => {
    const original = { logs: [{ source: 'chrome', event_type: 'url_visit', payload: { domain: 'bilibili.com' }, logged_at: 1750000000 }] }
    const enc = await encryptJson(original, TEST_KEY)
    const dec = await decryptJson<typeof original>(enc, TEST_KEY)
    expect(dec).toEqual(original)
  })

  it('密文结构：base64(iv(12) ‖ ct ‖ tag(16))，长度 = 明文 + 28', async () => {
    const enc = await encryptJson({ hello: 'world' }, TEST_KEY)
    const raw = Uint8Array.from(atob(enc), c => c.charCodeAt(0))
    const plainLen = JSON.stringify({ hello: 'world' }).length
    expect(raw.length).toBe(plainLen + 28)
  })

  it('密钥错误：返回 null，不抛异常', async () => {
    const enc = await encryptJson({ a: 1 }, 'key-a')
    const dec = await decryptJson(enc, 'key-b')
    expect(dec).toBeNull()
  })

  it('损坏数据：返回 null', async () => {
    expect(await decryptJson('not-base64!!', TEST_KEY)).toBeNull()
    expect(await decryptJson('', TEST_KEY)).toBeNull()
  })

  it('envelope：enc/v 标记与 data 字段', async () => {
    const env = await encryptEnvelope({ logs: [] }, TEST_KEY)
    expect(env).toMatchObject({ enc: true, v: 1 })
    expect(typeof env.data).toBe('string')
  })

  it('unwrapBody：加密信封解密为明文 JSON 字符串', async () => {
    const env = await encryptEnvelope({ logs: [{ a: 1 }] }, TEST_KEY)
    const plain = await unwrapBody(env, TEST_KEY)
    expect(JSON.parse(plain!)).toEqual({ logs: [{ a: 1 }] })
  })

  it('unwrapBody：明文 body 原样序列化（旧客户端兼容）', async () => {
    const plain = await unwrapBody({ logs: [{ a: 2 }] }, TEST_KEY)
    expect(JSON.parse(plain!)).toEqual({ logs: [{ a: 2 }] })
  })

  it('unwrapBody：密钥错误返回 null', async () => {
    const env = await encryptEnvelope({ logs: [] }, TEST_KEY)
    expect(await unwrapBody(env, 'wrong-key')).toBeNull()
  })

  it('resolveDataKey：env 优先', () => {
    expect(resolveDataKey({ ANCHOR_DATA_KEY: 'my-secret' })).toBe('my-secret')
    expect(resolveDataKey({ ANCHOR_DATA_KEY: '  padded  ' })).toBe('padded')
  })

  it('resolveDataKey：未配置时显式抛错（无内置回退）', () => {
    expect(() => resolveDataKey({})).toThrow(/ANCHOR_DATA_KEY/)
    expect(() => resolveDataKey()).toThrow(/ANCHOR_DATA_KEY/)
    expect(() => resolveDataKey({ ANCHOR_DATA_KEY: '   ' })).toThrow(/ANCHOR_DATA_KEY/)
  })

  it('generateDataKey：生成 64 位十六进制（32 字节随机）', () => {
    const key = generateDataKey()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    // 两次生成应不同（随机性）
    expect(generateDataKey()).not.toBe(key)
  })
})
