import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createWsClient } from './ws-client'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  sent: string[] = []
  readyState = 0

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  // test helper to simulate server message
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  // test helper to simulate open
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

describe('createWsClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects to the provided url', () => {
    const client = createWsClient('ws://localhost:4000', {})
    client.connect()
    expect(MockWebSocket.instances.length).toBe(1)
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:4000')
  })

  it('reports ready after open', () => {
    const onOpen = vi.fn()
    const client = createWsClient('ws://localhost:4000', { onOpen })
    client.connect()
    expect(client.ready).toBe(false)
    MockWebSocket.instances[0].open()
    expect(client.ready).toBe(true)
    expect(onOpen).toHaveBeenCalled()
  })

  it('sends messages when ready', () => {
    const client = createWsClient('ws://localhost:4000', {})
    client.connect()
    MockWebSocket.instances[0].open()
    const ok = client.send({ type: 'pong' })
    expect(ok).toBe(true)
    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: 'pong' }))
  })

  it('does not send when not ready', () => {
    const client = createWsClient('ws://localhost:4000', {})
    client.connect()
    const ok = client.send({ type: 'pong' })
    expect(ok).toBe(false)
  })

  it('forwards server messages to handler', () => {
    const onMessage = vi.fn()
    const client = createWsClient('ws://localhost:4000', { onMessage })
    client.connect()
    MockWebSocket.instances[0].open()
    MockWebSocket.instances[0].receive({ type: 'ping' })
    expect(onMessage).toHaveBeenCalledWith({ type: 'ping' })
  })

  it('reconnects with exponential backoff', () => {
    const client = createWsClient('ws://localhost:4000', {})
    client.connect()
    MockWebSocket.instances[0].close()
    expect(MockWebSocket.instances.length).toBe(1)
    vi.advanceTimersByTime(2100)
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('token 存在时 auth 是连接后的第一条消息', () => {
    const onOpen = vi.fn()
    const client = createWsClient('ws://localhost:4000', { token: 'tok-1', onOpen })
    client.connect()
    const ws = MockWebSocket.instances[0]
    ws.open()
    expect(onOpen).toHaveBeenCalled()
    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'auth', token: 'tok-1' }))
  })

  it('无 token 时不发送 auth', () => {
    const client = createWsClient('ws://localhost:4000', {})
    client.connect()
    MockWebSocket.instances[0].open()
    expect(MockWebSocket.instances[0].sent).toEqual([])
  })

  it('auth_failed 消息：回调 onAuthFailed 且停止重连', () => {
    const onAuthFailed = vi.fn()
    const client = createWsClient('ws://localhost:4000', { token: 'bad', onAuthFailed })
    client.connect()
    const ws = MockWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'auth_failed' })
    expect(onAuthFailed).toHaveBeenCalled()
    ws.close() // 普通断线也不再重连
    vi.advanceTimersByTime(60000)
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('close code 4401：回调 onAuthFailed 且停止重连', () => {
    const onAuthFailed = vi.fn()
    const client = createWsClient('ws://localhost:4000', { token: 'bad', onAuthFailed })
    client.connect()
    const ws = MockWebSocket.instances[0]
    ws.open()
    ws.onclose?.({ code: 4401 } as CloseEvent)
    expect(onAuthFailed).toHaveBeenCalled()
    vi.advanceTimersByTime(60000)
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('认证阶段普通断线：走既有重连逻辑', () => {
    const onAuthFailed = vi.fn()
    const client = createWsClient('ws://localhost:4000', { token: 'tok', onAuthFailed })
    client.connect()
    MockWebSocket.instances[0].close()
    expect(onAuthFailed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2100)
    expect(MockWebSocket.instances.length).toBe(2)
  })
})
