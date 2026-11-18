import WebSocket from 'ws'
import type { WsServerMessage, WsClientMessage } from '@anchor/types'
import { encryptEnvelope } from '@anchor/utils'

let _dataKey: string | null = null
let _token: string | null = null
let _configError: string | null = null
// 认证失效闩：auth_failed / close 4401 后置位，阻止重连风暴，重新配对后复位
let _authInvalid = false

const MAX_RETRIES = 10
const RETRY_DELAY_MS = 5000

let ws: WebSocket | null = null
let retryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

export type MessageHandler = (msg: WsServerMessage) => void
const handlers: MessageHandler[] = []

export type ReconnectHandler = () => void
const reconnectHandlers: ReconnectHandler[] = []

export type AuthInvalidHandler = () => void
const authInvalidHandlers: AuthInvalidHandler[] = []
const authOkHandlers: AuthInvalidHandler[] = []

/** WebSocket 工厂（可注入 mock 以便单测） */
export type WsFactory = (url: string) => WebSocket
let _wsFactory: WsFactory = (url) => new WebSocket(url)
export function setWsFactory(factory: WsFactory | null): void {
  _wsFactory = factory ?? ((url) => new WebSocket(url))
}

export interface ConnectOptions {
  /** 上行加密密钥；空/未提供视为未配置（null），send 显式拒绝上报 */
  dataKey?: string | null
  /** 设备 token；连接后首条消息明文发送 {type:'auth', token} */
  token?: string | null
}

/** 设置上行加密密钥，应在 connect 前调用。空串视为未配置（null） */
export function setDataKey(key: string): void {
  _dataKey = key.trim() || null
}

/** 设置配置错误状态，禁止发送消息 */
export function setConfigError(error: string | null): void {
  _configError = error
}

/** 获取配置错误状态 */
export function getConfigError(): string | null {
  return _configError
}

/** 认证是否已失效（auth_failed / close 4401） */
export function isAuthInvalid(): boolean {
  return _authInvalid
}

/** 重新配对成功后复位认证失效闩 */
export function resetAuthInvalid(): void {
  _authInvalid = false
}

/** 注册认证失效回调（auth_failed 或 close 4401，已停止重连） */
export function onAuthInvalid(handler: AuthInvalidHandler): void {
  authInvalidHandlers.push(handler)
}

/** 注册认证成功回调（auth_ok，清除失效态） */
export function onAuthOk(handler: AuthInvalidHandler): void {
  authOkHandlers.push(handler)
}

/** 注册每次 WebSocket（重）连接成功时的回调。 */
export function onReconnect(handler: ReconnectHandler): void {
  reconnectHandlers.push(handler)
}

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler)
}

/** 标记认证失效：停重连 + 通知上层（状态栏置「配对失效」） */
function markAuthInvalid(): void {
  if (_authInvalid) return
  _authInvalid = true
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryCount = MAX_RETRIES // 阻止既有 close 回调再排重连
  authInvalidHandlers.forEach((h) => h())
}

export function connect(serverUrl: string, options: ConnectOptions | string | null = {}): void {
  // 兼容旧签名 connect(url, dataKey)
  const opts: ConnectOptions = typeof options === 'string' ? { dataKey: options } : (options ?? {})
  _dataKey = (opts.dataKey ?? '').toString().trim() || null
  _token = opts.token?.trim() || null

  // 若已有连接或重连计时器，先清理
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (ws) {
    ws.removeAllListeners()
    ws.close()
  }

  ws = _wsFactory(serverUrl)

  ws.on('open', () => {
    retryCount = 0
    // 首条消息必须是明文 auth（控制消息不走加密信封）
    if (_token) {
      ws?.send(JSON.stringify({ type: 'auth', token: _token } satisfies WsClientMessage))
    }
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
      if (msg.type === 'auth_failed') {
        markAuthInvalid()
        ws?.close(4401, 'auth failed')
      } else if (msg.type === 'auth_ok') {
        if (_authInvalid) {
          _authInvalid = false
        }
        authOkHandlers.forEach((h) => h())
      }
      handlers.forEach((h) => h(msg))
    } catch {
      // 忽略无法解析的帧
    }
  })

  ws.on('close', (code) => {
    // close 4401：服务器认证门拒绝，等同 auth_failed
    if (code === 4401) {
      markAuthInvalid()
      console.warn('[Anchor WS] 认证失败（4401），停止重连')
      return
    }
    if (_authInvalid) {
      console.warn('[Anchor WS] 认证失效期间断线，停止重连')
      return
    }
    if (retryCount < MAX_RETRIES) {
      retryCount++
      console.log(`[Anchor WS] disconnected, retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`)
      retryTimer = setTimeout(() => connect(serverUrl, { dataKey: _dataKey, token: _token }), RETRY_DELAY_MS)
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
  // 未配置数据密钥：显式拒绝上报（等待配对），绝不回落内置密钥
  if (_dataKey === null) {
    console.warn('[Anchor WS] 未配置数据密钥，拒绝上报；请完成配对')
    return
  }
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
