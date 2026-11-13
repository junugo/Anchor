import type {
  FocusLayerStatusResponse,
  FocusLayerConfirmRequest,
  FocusLayerConfirmResponse,
  AnchorSyncOutPayload,
} from '@anchor/types'

const DEFAULT_BASE_URL = 'http://localhost:3000'
const REQUEST_TIMEOUT_MS = 3_000

// ─── mDNS 自动发现 ────────────────────────────────────────────────────────────

let _resolvedBaseUrl: string | null = null
let _mdnsResolved = false

async function startMdnsDiscovery(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 3 秒内未发现，fallback 到 env 变量
      if (!_mdnsResolved) {
        _resolvedBaseUrl = null
      }
      resolve()
    }, 3_000)

    try {
      // bonjour-service 是可选依赖；若不存在则静默 fallback
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { default: Bonjour } = require('bonjour-service') as {
        default: new () => {
          find(opts: { type: string }, cb: (svc: { host: string; port: number }) => void): void
          destroy(): void
        }
      }
      const bonjour = new Bonjour()
      bonjour.find({ type: 'focuslayer' }, (svc) => {
        clearTimeout(timer)
        _resolvedBaseUrl = `http://${svc.host}:${svc.port}`
        _mdnsResolved = true
        bonjour.destroy()
        resolve()
      })
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

// 启动时异步执行 mDNS 发现（不阻塞模块加载）
const _mdnsReady: Promise<void> = startMdnsDiscovery()

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return (
    _resolvedBaseUrl ??
    process.env['FOCUSLAYER_SERVER_URL'] ??
    DEFAULT_BASE_URL
  )
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = process.env['FOCUSLAYER_API_KEY']
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

async function safeFetch<T>(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T | null> {
  try {
    await _mdnsReady
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// ─── 客户端单例 ───────────────────────────────────────────────────────────────

export const focusLayerClient = {
  /** 检查是否已配置（env 变量或 mDNS 发现到服务） */
  isEnabled(): boolean {
    return _mdnsResolved || !!process.env['FOCUSLAYER_SERVER_URL']
  },

  /** GET /api/anchor/status */
  async queryStatus(): Promise<FocusLayerStatusResponse | null> {
    if (!this.isEnabled()) return null
    return safeFetch<FocusLayerStatusResponse>(
      `${getBaseUrl()}/api/anchor/status`,
      { method: 'GET', headers: getHeaders() }
    )
  },

  /** POST /api/anchor/confirm */
  async confirmWork(
    payload: FocusLayerConfirmRequest
  ): Promise<FocusLayerConfirmResponse | null> {
    if (!this.isEnabled()) return null
    return safeFetch<FocusLayerConfirmResponse>(
      `${getBaseUrl()}/api/anchor/confirm`,
      { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) }
    )
  },

  /** POST /api/anchor/sync — 通知解离事件 */
  async notifyDissociation(): Promise<void> {
    if (!this.isEnabled()) return
    await safeFetch<unknown>(
      `${getBaseUrl()}/api/anchor/sync`,
      { method: 'POST', headers: getHeaders(), body: JSON.stringify({ type: 'dissociation' }) }
    )
  },

  /** POST /api/anchor/sync-out — 上报 Anchor 节律数据 */
  async syncOut(payload: AnchorSyncOutPayload): Promise<void> {
    if (!this.isEnabled()) return
    await safeFetch<unknown>(
      `${getBaseUrl()}/api/anchor/sync-out`,
      { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) }
    )
  },
}
