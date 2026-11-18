import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import WebSocket from 'ws'
import {
  connect, disconnect, setWsFactory, onAuthInvalid, onAuthOk,
  isAuthInvalid, resetAuthInvalid,
} from '../ws-client'

// 最小可注入的 WebSocket mock：记录 send、可派发 open/message/close/error
class FakeWs {
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, cb: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((cb) => cb(...args))
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number) {
    this.readyState = 3
    this.emit('close', code ?? 1000)
  }

  removeAllListeners() {
    this.listeners.clear()
  }
}

let fake: FakeWs

beforeEach(() => {
  vi.useFakeTimers()
  fake = new FakeWs()
  setWsFactory(() => fake as unknown as WebSocket)
})

afterEach(() => {
  disconnect()
  resetAuthInvalid()
  setWsFactory(null)
  vi.useRealTimers()
})

describe('ws-client 认证行为', () => {
  it('连接 open 后首条消息是明文 auth', () => {
    connect('ws://x/ws', { token: 'tok-1', dataKey: 'dk' })
    fake.emit('open')
    expect(fake.sent).toHaveLength(1)
    expect(JSON.parse(fake.sent[0])).toEqual({ type: 'auth', token: 'tok-1' })
  })

  it('收到 auth_failed：触发回调、停止重连、置失效闩', () => {
    const onInvalid = vi.fn()
    onAuthInvalid(onInvalid)
    connect('ws://x/ws', { token: 'bad', dataKey: 'dk' })
    fake.emit('open')
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'auth_failed' })))
    expect(onInvalid).toHaveBeenCalledOnce()
    expect(isAuthInvalid()).toBe(true)
    // 认证期断线不再触发重连
    fake.emit('close', 4401)
    vi.advanceTimersByTime(60_000)
    expect(onInvalid).toHaveBeenCalledOnce()
  })

  it('close 4401 直接触发失效回调且不弹普通重连', () => {
    const onInvalid = vi.fn()
    onAuthInvalid(onInvalid)
    connect('ws://x/ws', { token: 'tok', dataKey: 'dk' })
    fake.emit('open')
    fake.emit('close', 4401)
    expect(onInvalid).toHaveBeenCalledOnce()
    expect(isAuthInvalid()).toBe(true)
  })

  it('auth_ok 清除失效态', () => {
    const onOk = vi.fn()
    onAuthOk(onOk)
    connect('ws://x/ws', { token: 'tok', dataKey: 'dk' })
    fake.emit('open')
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'auth_failed' })))
    expect(isAuthInvalid()).toBe(true)
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok', deviceId: 3 })))
    expect(onOk).toHaveBeenCalledOnce()
    expect(isAuthInvalid()).toBe(false)
  })

  it('普通断线按既有重连逻辑重试', () => {
    connect('ws://x/ws', { token: 'tok', dataKey: 'dk' })
    fake.emit('open')
    fake.emit('close', 1006)
    expect(isAuthInvalid()).toBe(false)
    // 5 秒后应发起重连（工厂再次被调用）
    const factorySpy = vi.fn(() => fake as unknown as WebSocket)
    setWsFactory(factorySpy)
    vi.advanceTimersByTime(5_000)
    expect(factorySpy).toHaveBeenCalled()
  })
})
