import { describe, it, expect } from 'vitest'
import { createSecretsApi, shouldConnect, type SecretStorageLike } from '../secrets'

// 内存版 SecretStorage mock：模拟 vscode.SecretStorage 的 Thenable 行为
function createMockSecretStorage() {
  const map = new Map<string, string>()
  const storage: SecretStorageLike = {
    get: (key) => Promise.resolve(map.get(key)),
    store: (key, value) => { map.set(key, value); return Promise.resolve() },
    delete: (key) => { map.delete(key); return Promise.resolve() },
  }
  return { storage, map }
}

describe('secrets 模块', () => {
  it('setPaired 写入四个键，getToken/getDataKey 可往返读出', async () => {
    const { storage } = createMockSecretStorage()
    const secrets = createSecretsApi(storage)

    expect(await secrets.getToken()).toBeNull()
    expect(await secrets.getDataKey()).toBeNull()

    await secrets.setPaired({
      token: 'tok-abc',
      dataKey: 'key-xyz',
      deviceName: 'DEV-PC',
      pairedAt: 1730000000000,
    })

    expect(await secrets.getToken()).toBe('tok-abc')
    expect(await secrets.getDataKey()).toBe('key-xyz')
    expect(await secrets.getDeviceName()).toBe('DEV-PC')
  })

  it('setPaired 覆盖旧凭据', async () => {
    const { storage } = createMockSecretStorage()
    const secrets = createSecretsApi(storage)
    await secrets.setPaired({ token: 'old', dataKey: 'old-key', deviceName: 'A', pairedAt: 1 })
    await secrets.setPaired({ token: 'new', dataKey: 'new-key', deviceName: 'B', pairedAt: 2 })
    expect(await secrets.getToken()).toBe('new')
    expect(await secrets.getDataKey()).toBe('new-key')
  })

  it('clear 删除全部凭据', async () => {
    const { storage } = createMockSecretStorage()
    const secrets = createSecretsApi(storage)
    await secrets.setPaired({ token: 'tok', dataKey: 'key', deviceName: 'A', pairedAt: 1 })
    await secrets.clear()
    expect(await secrets.getToken()).toBeNull()
    expect(await secrets.getDataKey()).toBeNull()
    expect(await secrets.getDeviceName()).toBeNull()
  })

  it('shouldConnect：有 token 才允许连接', () => {
    expect(shouldConnect('tok')).toBe(true)
    expect(shouldConnect(null)).toBe(false)
    expect(shouldConnect(undefined)).toBe(false)
    expect(shouldConnect('')).toBe(false)
  })
})
