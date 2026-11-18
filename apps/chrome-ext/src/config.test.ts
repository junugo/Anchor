import { beforeEach, describe, expect, it } from 'vitest'
import { defaultDeviceName, getServerConfig, isPaired, loadServerConfig, saveServerConfig } from './config'
import { installChromeMock } from './testing/chrome-mock'

describe('config', () => {
  beforeEach(() => {
    installChromeMock()
  })

  it('loadServerConfig 缺省：无存储时 token/deviceName/pairedAt 为 null', async () => {
    const cfg = await loadServerConfig()
    // serverUrl/dataKey 缺省为构建期 VITE_* 或内置默认（本机 .env 可能有覆盖，只校验配对三字段为 null）
    expect(cfg.serverUrl.length).toBeGreaterThan(0)
    expect(cfg.token).toBeNull()
    expect(cfg.deviceName).toBeNull()
    expect(cfg.pairedAt).toBeNull()
  })

  it('完整往返：saveServerConfig 写入后 loadServerConfig 读回', async () => {
    await saveServerConfig({
      serverUrl: ' http://192.168.1.2:4000 ',
      dataKey: 'key-abc',
      token: 'tok-1',
      deviceName: 'Chrome · Windows',
      pairedAt: 1234567890,
    })
    const cfg = await loadServerConfig()
    expect(cfg).toEqual({
      serverUrl: 'http://192.168.1.2:4000',
      dataKey: 'key-abc',
      token: 'tok-1',
      deviceName: 'Chrome · Windows',
      pairedAt: 1234567890,
    })
    expect(getServerConfig().token).toBe('tok-1')
  })

  it('isPaired：token 非空为已配对', () => {
    const base = { serverUrl: '', dataKey: null, deviceName: null, pairedAt: null }
    expect(isPaired({ ...base, token: null })).toBe(false)
    expect(isPaired({ ...base, token: '' })).toBe(false)
    expect(isPaired({ ...base, token: 'tok' })).toBe(true)
  })

  it('defaultDeviceName：纯函数生成「Chrome · 平台」', () => {
    expect(defaultDeviceName('Windows')).toBe('Chrome · Windows')
    expect(defaultDeviceName('macOS')).toBe('Chrome · macOS')
  })

  it('defaultDeviceName：无入参时回退到 navigator', () => {
    const name = defaultDeviceName()
    expect(name.startsWith('Chrome ·')).toBe(true)
  })
})
