/**
 * 服务器连接配置（服务器地址 + 上行数据密钥 + 配对凭证）。
 *
 * 取值优先级：chrome.storage.local 用户配置 > 构建期 VITE_* 环境变量。
 * dataKey / token 为 null 表示未配置：dataKey 缺失时 background 在加密上报处显式拒绝；
 * token 缺失（未配对）时 background 不建立 WS 连接，等待选项页完成配对。
 * 用户在扩展选项页保存或完成配对后即时生效：background 订阅 onServerConfigChange 自动重连，
 * 无需重新加载扩展或重新打包。
 */

export interface ServerConfig {
  serverUrl: string
  /** 上行数据密钥；null = 未配置（由配对流程下发，或在选项页手动填写） */
  dataKey: string | null
  /** 配对下发的设备 token；null = 未配对 */
  token: string | null
  /** 配对时使用的设备名（展示用） */
  deviceName: string | null
  /** 配对成功时间戳（ms）；null = 未配对 */
  pairedAt: number | null
}

const STORAGE_KEYS = {
  serverUrl: 'anchor:serverUrl',
  dataKey: 'anchor:dataKey',
  token: 'anchor:token',
  deviceName: 'anchor:deviceName',
  pairedAt: 'anchor:pairedAt',
} as const

/** 配对失效标记（WS auth_failed / close 4401 时置位；重新配对成功清除） */
export const PAIR_INVALID_KEY = 'anchor:pairInvalid'

const ENV_DEFAULTS: ServerConfig = {
  serverUrl: (import.meta.env.VITE_ANCHOR_SERVER as string | undefined)?.trim() || 'http://localhost:4000',
  dataKey: (import.meta.env.VITE_ANCHOR_DATA_KEY as string | undefined)?.trim() || null,
  token: null,
  deviceName: null,
  pairedAt: null,
}

let cached: ServerConfig = { ...ENV_DEFAULTS }

/** 从 chrome.storage.local 加载用户配置并刷新缓存；background 启动时调用一次 */
export async function loadServerConfig(): Promise<ServerConfig> {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS))
  cached = {
    serverUrl: (stored[STORAGE_KEYS.serverUrl] as string | undefined)?.trim() || ENV_DEFAULTS.serverUrl,
    dataKey: (stored[STORAGE_KEYS.dataKey] as string | undefined)?.trim() || ENV_DEFAULTS.dataKey,
    token: (stored[STORAGE_KEYS.token] as string | undefined)?.trim() || null,
    deviceName: (stored[STORAGE_KEYS.deviceName] as string | undefined)?.trim() || null,
    pairedAt: (stored[STORAGE_KEYS.pairedAt] as number | undefined) ?? null,
  }
  return cached
}

/** 当前生效配置（同步读取缓存；loadServerConfig 完成前为构建期/内置默认） */
export function getServerConfig(): ServerConfig {
  return cached
}

/** 是否已完成配对（token 非空） */
export function isPaired(cfg: ServerConfig): boolean {
  return cfg.token != null && cfg.token !== ''
}

/** 保存用户配置到 chrome.storage.local 并刷新缓存；空白值视为清除（dataKey 归 null） */
export async function saveServerConfig(patch: Partial<ServerConfig>): Promise<void> {
  const next: ServerConfig = {
    serverUrl: patch.serverUrl?.trim() || ENV_DEFAULTS.serverUrl,
    dataKey: patch.dataKey?.trim() || ENV_DEFAULTS.dataKey,
    token: patch.token?.trim() || null,
    deviceName: patch.deviceName?.trim() || null,
    pairedAt: patch.pairedAt ?? null,
  }
  const entries: Record<string, string | number> = {}
  if (patch.serverUrl !== undefined) entries[STORAGE_KEYS.serverUrl] = patch.serverUrl
  if (patch.dataKey !== undefined) entries[STORAGE_KEYS.dataKey] = patch.dataKey ?? ''
  if (patch.token !== undefined) entries[STORAGE_KEYS.token] = patch.token ?? ''
  if (patch.deviceName !== undefined) entries[STORAGE_KEYS.deviceName] = patch.deviceName ?? ''
  if (patch.pairedAt !== undefined) entries[STORAGE_KEYS.pairedAt] = patch.pairedAt ?? 0
  await chrome.storage.local.set(entries)
  cached = next
}

/** 生成默认设备名：「Chrome · 平台」（如「Chrome · Windows」） */
export function defaultDeviceName(platform?: string): string {
  const p = platform ?? (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return `Chrome · ${p}`.trim()
}

/** 用户配置变更订阅（选项页保存 / 配对成功后 background 重连用） */
export function onServerConfigChange(handler: (cfg: ServerConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const keys = [STORAGE_KEYS.serverUrl, STORAGE_KEYS.dataKey, STORAGE_KEYS.token]
    if (!keys.some((k) => changes[k])) return
    void loadServerConfig().then(handler)
  })
}

/** http(s) 服务器地址 → ws(s) WebSocket 地址 */
export function wsUrlFor(serverUrl: string): string {
  return serverUrl.trim().replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws'
}
