import type { WsClientMessage, WsServerMessage } from '@anchor/types'
import type { EncryptedEnvelope } from '@anchor/utils'

export interface WsClientHandlers {
  onOpen?: () => void
  onClose?: () => void
  onMessage?: (msg: WsServerMessage) => void
}

export interface WsClient {
  readonly ready: boolean
  connect: () => void
  send: (msg: WsClientMessage | EncryptedEnvelope) => boolean
  /** 关闭连接并抑制自动重连（配置变更切换服务器时使用） */
  close: () => void
}

export function createWsClient(url: string, handlers: WsClientHandlers): WsClient {
  let ws: WebSocket | null = null
  let ready = false
  let reconnectAttempt = 0
  let closed = false

  function connect() {
    if (closed) return
    ws = new WebSocket(url)
    ws.onopen = () => {
      ready = true
      reconnectAttempt = 0
      handlers.onOpen?.()
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsServerMessage
        handlers.onMessage?.(msg)
      } catch { /* ignore */ }
    }
    ws.onerror = () => { /* 错误处理交给 onclose */ }
    ws.onclose = () => {
      ready = false
      handlers.onClose?.()
      if (closed) return
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000) + Math.floor(Math.random() * 1000)
      reconnectAttempt++
      setTimeout(connect, delay)
    }
  }

  return {
    get ready() {
      return ready
    },
    connect,
    send(msg: WsClientMessage | EncryptedEnvelope): boolean {
      if (!ready || !ws) return false
      try {
        ws.send(JSON.stringify(msg))
        return true
      } catch {
        ready = false
        return false
      }
    },
    close(): void {
      closed = true
      ready = false
      ws?.close()
      ws = null
    },
  }
}
