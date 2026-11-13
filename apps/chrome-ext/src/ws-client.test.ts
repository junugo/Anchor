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
})
