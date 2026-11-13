import WebSocket from 'ws'
import type { WsServerMessage, WsClientMessage } from '@anchor/types'
import { DEFAULT_DATA_KEY, encryptEnvelope } from '@anchor/utils'

let _dataKey = DEFAULT_DATA_KEY
let _configError: string | null = null

const MAX_RETRIES = 10
const RETRY_DELAY_MS = 5000

let ws: WebSocket | null = null
let retryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

export type MessageHandler = (msg: WsServerMessage) => void
const handlers: MessageHandler[] = []

export type ReconnectHandler = () => void
const reconnectHandlers: ReconnectHandler[] = []

/** 设置上行加密密钥，应在 connect 前调用。 */
export function setDataKey(key: string): void {
  _dataKey = key.trim() || DEFAULT_DATA_KEY
}

/** 设置配置错误状态，禁止发送消息 */
export function setConfigError(error: string | null): void {
  _configError = error
}

/** 获取配置错误状态 */
export function getConfigError(): string | null {
  return _configError
}

/** 注册每次 WebSocket（重）连接成功时的回调。 */
export function onReconnect(handler: ReconnectHandler): void {
  reconnectHandlers.push(handler)
}

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler)
}

export function connect(serverUrl: string, dataKey?: string): void {
  if (dataKey) setDataKey(dataKey)

  // 若已有连接或重连计时器，先清理
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (ws) {
    ws.removeAllListeners()
    ws.close()
  }

  ws = new WebSocket(serverUrl)

  ws.on('open', () => {
    retryCount = 0
    reconnectHandlers.forEach((h) => h())
    console.log('[Anchor WS] connected')
  })

  ws.on('message', (data) => {
    try {
      const msg: WsServerMessage = JSON.parse(data.toString())
      if (msg.type === 'ping') {
        send({ type: 'pong' })
        return
      }
      handlers.forEach((h) => h(msg))
    } catch {
      // 忽略无法解析的帧
    }
  })

  ws.on('close', () => {
    if (retryCount < MAX_RETRIES) {
      retryCount++
      console.log(`[Anchor WS] disconnected, retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`)
      retryTimer = setTimeout(() => connect(serverUrl), RETRY_DELAY_MS)
    } else {
      console.warn('[Anchor WS] max retries reached, giving up')
    }
  })

  ws.on('error', (err) => {
    console.warn('[Anchor WS] error:', err.message)
    ws?.close()
  })
}

export async function send(msg: WsClientMessage): Promise<void> {
  // 配置错误状态：禁止发送
  if (_configError) {
    console.log('[Anchor WS] 配置错误，跳过发送')
    return
  }
  if (ws?.readyState !== WebSocket.OPEN) return
  try {
    const envelope = await encryptEnvelope(msg, _dataKey)
    ws.send(JSON.stringify(envelope))
  } catch (err) {
    console.warn('[Anchor WS] encrypt/send failed:', err)
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}

export function disconnect(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryCount = MAX_RETRIES // 阻止重连
  ws?.close()
  ws = null
}
