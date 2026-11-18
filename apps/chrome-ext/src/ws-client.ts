import type { WsClientMessage, WsServerMessage } from '@anchor/types'
import type { EncryptedEnvelope } from '@anchor/utils'

export interface WsClientHandlers {
  onOpen?: () => void
  onClose?: () => void
  onMessage?: (msg: WsServerMessage) => void
  /** 认证失败（auth_failed 消息或 close code 4401）：调用方应置 pairInvalid 并停止重连 */
  onAuthFailed?: () => void
}

export interface WsClientOptions extends WsClientHandlers {
  /** 配对下发的设备 token；提供后连接建立首条消息发 {type:'auth',token} */
  token?: string | null
}

export interface WsClient {
  readonly ready: boolean
  connect: () => void
  send: (msg: WsClientMessage | EncryptedEnvelope) => boolean
  /** 关闭连接并抑制自动重连（配置变更切换服务器时使用） */
  close: () => void
}

/** 服务器拒绝配对凭证的 WS 关闭码 */
export const WS_CLOSE_AUTH_FAILED = 4401

export function createWsClient(url: string, handlers: WsClientOptions): WsClient {
  let ws: WebSocket | null = null
  let ready = false
  let reconnectAttempt = 0
  let closed = false
  // 认证失败后不再重连（避免重连风暴），直到调用方 close() 重建 client（重新配对成功）
  let authInvalid = false

  function connect() {
    if (closed) return
    ws = new WebSocket(url)
    ws.onopen = () => {
      ready = true
      reconnectAttempt = 0
      // 认证消息必须是第一条，随后才允许业务消息（onOpen 会触发队列补发）
      if (handlers.token) {
        try {
          ws?.send(JSON.stringify({ type: 'auth', token: handlers.token } satisfies WsClientMessage))
        } catch { /* ignore */ }
      }
      handlers.onOpen?.()
    }
    ws.onmessage = (event) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(event.data as string) as WsServerMessage
      } catch { /* ignore */ return }
      if (msg.type === 'auth_failed') {
        authInvalid = true
        handlers.onAuthFailed?.()
        return
      }
      handlers.onMessage?.(msg)
    }
    ws.onerror = () => { /* 错误处理交给 onclose */ }
    ws.onclose = (event) => {
      ready = false
      handlers.onClose?.()
      if (closed) return
      if ((event as CloseEvent | undefined)?.code === WS_CLOSE_AUTH_FAILED) {
        authInvalid = true
        handlers.onAuthFailed?.()
        return
      }
      if (authInvalid) return
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
